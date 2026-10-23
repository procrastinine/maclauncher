const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJsonAtomic } = require("./json-files");
const { checkExistingDownload, createDownloadIdentity } = require("./external-download-duplicates");
const { createItchPublicGames, publicGameUrl } = require("./itch-public-games");

const API = "https://api.itch.io";
const clone = value => JSON.parse(JSON.stringify(value));
const publicError = message => Object.assign(new Error(message), { itchPublic: true });
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function numeric(value, label) {
  const result = String(value ?? "");
  if (!/^[1-9]\d{0,15}$/.test(result) || !Number.isSafeInteger(Number(result))) throw publicError(`Invalid itch.io ${label} ID.`);
  return result;
}
function platforms(record) {
  const traits = new Set(Array.isArray(record?.traits) ? record.traits : []), values = record?.platforms || {};
  const result = [values.windows || record?.p_windows || traits.has("p_windows") ? "windows" : null,
    values.osx || values.macos || record?.p_osx || traits.has("p_osx") ? "macos" : null,
    values.linux || record?.p_linux || traits.has("p_linux") ? "linux" : null].filter(Boolean);
  if (record?.type === "html" || traits.has("html5")) result.push("web");
  return [...new Set(result)];
}
function safeError(error, fallback) {
  if (error?.itchPublic) return error.message;
  if (error?.code === "ENOSPC") return "There is not enough space for this download.";
  if (["EACCES", "EPERM"].includes(error?.code)) return "The selected download folder cannot be written.";
  return fallback;
}
function downloadAddress(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw publicError("itch.io returned an invalid download address."); }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || hostname === "localhost" || hostname.endsWith(".localhost") ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(hostname) || /^\[?(?:::1|fc|fd|fe80:)/i.test(hostname))
    throw publicError("itch.io returned an invalid download address.");
  // Authentication belongs in the header, including API-origin redirects.
  if ([...url.searchParams.keys()].some(key => /^(?:api_key|access_token|authorization)$/i.test(key))) throw publicError("itch.io returned a download address containing account credentials.");
  return url;
}
function filename(value, fallback) {
  const result = path.posix.basename(String(value || fallback).replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "").slice(0, 180);
  return !result || result === "." || result === ".." || result === ".maclauncher-external.json" ? fallback : result;
}
function hostedRevision(upload) {
  const checksum = typeof upload.sha256 === "string" && /^[a-f0-9]{64}$/i.test(upload.sha256) ? upload.sha256.toLowerCase() : null;
  const updatedAt = typeof upload.updated_at === "string" && Number.isFinite(Date.parse(upload.updated_at)) ? upload.updated_at : null;
  if (!checksum && !updatedAt) return null;
  return crypto.createHash("sha256").update(JSON.stringify({ checksum, updatedAt, size: Number(upload.size) || null })).digest("hex").slice(0, 20);
}

function createItchStoreDownloads(options = {}) {
  if (!path.isAbsolute(options.userDataDir || "")) throw publicError("A MacLauncher profile directory is required.");
  const root = path.join(options.userDataDir, "external", "itch"), defaultDirectory = path.join(options.userDataDir, "external", "downloads", "itch");
  const request = options.fetch || globalThis.fetch;
  const publicGames = createItchPublicGames({ fetch: request });
  let apiKey = "", generation = 0, disposed = false, session = new AbortController(), libraryLoading;
  const keys = new Map(), versions = new Map(), jobs = new Map();
  const state = { connection: { status: "disconnected", mode: "public", authUrl: "https://itch.io/user/settings/api-keys" },
    library: [], libraryLoading: false, libraryFetchedAt: null, libraryError: null, downloads: [], defaultDirectory, hasSavedKey: false };
  const snapshot = () => clone(state), emit = () => { if (!disposed) options.onChange?.(snapshot()); };
  const connected = () => { if (disposed || state.connection.status !== "connected" || state.connection.mode !== "public" && !apiKey) throw publicError("Choose public games or connect an itch.io account to continue."); };
  function assertCurrent(expected) { if (disposed || expected !== generation) throw publicError("The itch.io account changed. Connect again to continue."); }
  function combinedSignal(signal) { return signal ? AbortSignal.any([session.signal, signal]) : session.signal; }
  async function responseJson(response) {
    if (!response.ok) throw publicError(response.status === 401 || response.status === 403 ? "itch.io did not authorize this request. Check the API key and game access." : response.status === 429 ? "itch.io is limiting requests. Try again later." : "itch.io could not complete this request. Try again.");
    if (Number(response.headers.get("content-length")) > 16 * 1024 * 1024) throw publicError("itch.io returned too much metadata.");
    const text = await response.text();
    if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw publicError("itch.io returned too much metadata.");
    let value;
    try { value = JSON.parse(text); } catch { throw publicError("itch.io returned an invalid response."); }
    if (value?.errors?.length) throw publicError("itch.io did not authorize this request or the requested content is unavailable.");
    return value;
  }
  async function api(endpoint, query = {}, signal) {
    const currentGeneration = generation, url = new URL(endpoint, API);
    if (url.origin !== API) throw publicError("The itch.io API request is invalid.");
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const response = await request(url.href, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/vnd.itch.v2" }, redirect: "error", signal: combinedSignal(signal) });
    const value = await responseJson(response); assertCurrent(currentGeneration); return value;
  }
  // Saved credentials are supplied by the host's encrypted storage adapter.
  const savedReady = Promise.resolve().then(() => options.loadSession?.()).then(saved => { if (!disposed && generation === 0) { state.hasSavedKey = Boolean(saved?.apiKey); emit(); } return saved; }).catch(() => null);
  async function connect(credentials = {}) {
    if (disposed) throw publicError("The External window has closed.");
    if (jobs.size) throw publicError("Finish or cancel active downloads before changing itch.io accounts.");
    generation++; session.abort(); session = new AbortController(); apiKey = ""; libraryLoading = null; keys.clear(); versions.clear(); publicGames.dispose();
    state.connection = { status: "disconnected", mode: "manual", authUrl: "https://itch.io/user/settings/api-keys" };
    state.library = []; state.libraryFetchedAt = null; state.libraryLoading = false; state.libraryError = null;
    if (credentials.mode === "public") {
      const saved = readJson(path.join(root, "public", "library.json"), {});
      state.connection = { status: "connected", mode: "public", displayName: "Public games", userId: "public", authUrl: "https://itch.io/user/settings/api-keys" };
      state.library = Array.isArray(saved.library) ? saved.library.filter(game => {
        try { return numeric(game.appId, "game") && publicGameUrl(game.url); } catch { return false; }
      }).map(game => ({ ...game, appId: String(game.appId), public: true, store: "itch" })) : [];
      state.libraryFetchedAt = saved.fetchedAt || null; emit(); return snapshot();
    }
    const currentGeneration = generation, saved = !credentials.apiKey ? await options.loadSession?.() : await savedReady;
    assertCurrent(currentGeneration);
    state.hasSavedKey = Boolean(saved?.apiKey);
    const key = String(credentials.apiKey || saved?.apiKey || "").trim();
    if (!/^[^\s\x00-\x1f\x7f]{16,512}$/.test(key)) throw publicError("Enter a valid itch.io API key.");
    apiKey = key; state.connection = { status: "connecting", mode: credentials.mode === "reuse" ? "reuse" : "manual", authUrl: "https://itch.io/user/settings/api-keys" }; emit();
    try {
      const profile = await api("/profile");
      if (!profile.user?.id || !profile.user?.username) throw publicError("itch.io did not return an account profile.");
      state.connection = { ...state.connection, status: "connected", accountName: String(profile.user.username), displayName: String(profile.user.display_name || profile.user.username), userId: String(profile.user.id) };
      if (credentials.remember === true) {
        if (!options.saveSession) throw publicError("Saving API keys is unavailable in this profile.");
        await options.saveSession({ apiKey, accountName: state.connection.accountName, userId: state.connection.userId }); assertCurrent(currentGeneration); state.hasSavedKey = true;
      }
      emit(); await loadLibrary();
    } catch (error) {
      if (generation === currentGeneration && !disposed) { apiKey = ""; state.connection = { ...state.connection, status: "error", error: safeError(error, "itch.io could not connect. Check the API key and try again.") }; emit(); }
    }
    return snapshot();
  }
  async function loadLibrary({ refresh = false } = {}) {
    connected(); if (libraryLoading) return libraryLoading;
    if (!refresh && state.libraryFetchedAt) return clone(state.library);
    const currentGeneration = generation; state.libraryLoading = true; state.libraryError = null; emit();
    libraryLoading = (async () => {
      try {
        if (state.connection.mode === "public") {
          const rows = [];
          for (const game of state.library) rows.push(await publicGames.discoverGame(game.url, { refresh, signal: session.signal }));
          assertCurrent(currentGeneration); state.library = rows.sort((a, b) => a.name.localeCompare(b.name)); state.libraryFetchedAt = new Date().toISOString();
          writeJsonAtomic(path.join(root, "public", "library.json"), { library: state.library, fetchedAt: state.libraryFetchedAt }); return clone(state.library);
        }
        const rows = new Map(), nextKeys = new Map();
        // Short pages do not indicate completion for owned keys. The official
        // endpoint requires continuing until an empty page is returned.
        for (let page = 1; ; page++) {
          if (page > 1000) throw publicError("The itch.io library is too large to load in one request sequence.");
          const result = await api("/profile/owned-keys", { page, per_page: 500 });
          if (!Array.isArray(result.owned_keys)) throw publicError("itch.io did not return an owned game library.");
          if (!result.owned_keys.length) break;
          for (const owned of result.owned_keys) {
            const game = owned.game, appId = String(owned.game_id || game?.id || "");
            if (!game || !/^[1-9]\d*$/.test(appId)) continue;
            nextKeys.set(appId, String(owned.id));
            rows.set(appId, { appId, name: game.title || `itch.io game ${appId}`, platforms: platforms(game), shared: false,
              iconUrl: typeof game.cover_url === "string" && /^https:\/\/(?:img\.)?itch\.(?:zone|io)\//i.test(game.cover_url) ? game.cover_url : null,
              url: typeof game.url === "string" ? game.url : null, store: "itch" });
          }
        }
        assertCurrent(currentGeneration); keys.clear(); for (const [key, value] of nextKeys) keys.set(key, value);
        state.library = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)); state.libraryFetchedAt = new Date().toISOString();
        writeJsonAtomic(path.join(root, state.connection.userId, "library.json"), { library: state.library, fetchedAt: state.libraryFetchedAt }); return clone(state.library);
      } catch (error) { if (generation === currentGeneration) state.libraryError = safeError(error, "The itch.io library could not be loaded. Reload to try again."); throw publicError(state.libraryError || "The itch.io account changed."); }
      finally { if (generation === currentGeneration) { libraryLoading = null; state.libraryLoading = false; emit(); } }
    })();
    return libraryLoading;
  }
  async function addGame(url) {
    connected(); if (state.connection.mode !== "public") throw publicError("Choose Public games to add an itch.io game URL.");
    const currentGeneration = generation, game = await publicGames.discoverGame(url, { refresh: true, signal: session.signal });
    assertCurrent(currentGeneration);
    state.library = [...state.library.filter(item => item.appId !== game.appId), game].sort((a, b) => a.name.localeCompare(b.name));
    versions.delete(game.appId); state.libraryFetchedAt = new Date().toISOString(); state.libraryError = null;
    writeJsonAtomic(path.join(root, "public", "library.json"), { library: state.library, fetchedAt: state.libraryFetchedAt }); emit(); return snapshot();
  }
  function gameCredentials(appId) { const key = keys.get(String(appId)); return key ? { download_key_id: numeric(key, "download key") } : {}; }
  async function getVersions(value, { refresh = false, signal } = {}) {
    connected(); const appId = numeric(value, "game"), currentGeneration = generation;
    const cached = versions.get(appId);
    if (!refresh && cached) return clone(cached);
    if (state.connection.mode === "public") {
      const game = state.library.find(game => game.appId === appId); if (!game) throw publicError("Add the itch.io game page URL before loading its public downloads.");
      const catalog = await publicGames.getVersions(game, { refresh, signal: combinedSignal(signal) }); assertCurrent(currentGeneration);
      versions.set(appId, catalog); writeJsonAtomic(path.join(root, "public", "catalog", `${appId}.json`), catalog); return clone(catalog);
    }
    const result = await api(`/games/${appId}/uploads`, gameCredentials(appId), signal);
    if (!Array.isArray(result.uploads)) throw publicError("itch.io did not return downloadable uploads for this game.");
    const branches = [], uploadRows = [];
    for (const upload of result.uploads) {
      const uploadId = numeric(upload.id, "upload"), availablePlatforms = platforms(upload);
      if (upload.preorder || upload.storage === "external") continue;
      const label = upload.display_name || upload.channel_name || upload.filename || `Upload ${uploadId}`;
      const versionsForUpload = [];
      if (upload.storage === "build" || upload.build_id || upload.build?.id) {
        const history = await api(`/uploads/${uploadId}/builds`, gameCredentials(appId), signal);
        if (!Array.isArray(history.builds)) throw publicError("itch.io did not return published builds for this upload.");
        const builds = new Map(history.builds.map(build => [String(build.id), build]));
        if (upload.build?.id) builds.set(String(upload.build.id), { ...builds.get(String(upload.build.id)), ...upload.build });
        if (upload.build_id && !builds.has(String(upload.build_id))) {
          const current = await api(`/builds/${numeric(upload.build_id, "build")}`, gameCredentials(appId), signal);
          if (current.build) builds.set(String(current.build.id), current.build);
        }
        for (const build of [...builds.values()].sort((a, b) => Number(b.version || b.id) - Number(a.version || a.id))) {
          if (build.state && build.state !== "completed") continue;
          const buildId = numeric(build.id, "build"), archive = build.files?.find(file => file.type === "archive" && (!file.state || file.state === "uploaded") && (!file.sub_type || file.sub_type === "default"));
          const version = String(build.user_version || build.version || buildId), current = String(upload.build_id || upload.build?.id) === buildId;
          versionsForUpload.push({ id: `${uploadId}:${buildId}`, name: `${label} · ${version}${current ? " (latest)" : ""}`, uploadId, buildId, version,
            platforms: availablePlatforms, updatedAt: build.updated_at || build.created_at || null, size: Number(archive?.size) || null,
            filename: filename(upload.filename, `itch-${appId}-${uploadId}.zip`).replace(/(?:\.[a-z0-9]+)?$/i, ".zip"),
            checksum: typeof archive?.sha256 === "string" && /^[a-f0-9]{64}$/i.test(archive.sha256) ? archive.sha256.toLowerCase() : null });
        }
      } else {
        const revision = hostedRevision(upload);
        versionsForUpload.push({ id: `${uploadId}:file${revision ? `:${revision}` : ""}`, name: label, uploadId, buildId: null, version: null, platforms: availablePlatforms,
          exactIdentity: Boolean(revision), revision, updatedAt: upload.updated_at || upload.created_at || null, size: Number(upload.size) || null, filename: filename(upload.filename, `itch-${appId}-${uploadId}.zip`),
          checksum: typeof upload.sha256 === "string" && /^[a-f0-9]{64}$/i.test(upload.sha256) ? upload.sha256.toLowerCase() : null });
      }
      branches.push(...versionsForUpload); uploadRows.push({ id: uploadId, name: label, platforms: availablePlatforms, versions: versionsForUpload.map(row => row.id) });
    }
    assertCurrent(currentGeneration);
    const catalog = { appId, name: state.library.find(game => game.appId === appId)?.name || `itch.io game ${appId}`,
      platforms: [...new Set(branches.flatMap(branch => branch.platforms))], languages: [], branches, uploads: uploadRows,
      historyNote: "Published upload files and available build archives are listed. Access to earlier builds is controlled by itch.io and the publisher." };
    versions.set(appId, catalog); writeJsonAtomic(path.join(root, state.connection.userId, "catalog", `${appId}.json`), catalog); return clone(catalog);
  }
  async function transfer(endpoint, query, output, { signal, onProgress, expectedSize, checksum, headers = {}, expectedEtag }) {
    let address = new URL(endpoint, API); for (const [key, value] of Object.entries(query)) address.searchParams.set(key, String(value));
    let response;
    for (let redirects = 0; redirects < 10; redirects++) {
      signal.throwIfAborted(); address = downloadAddress(address.href);
      response = await request(address.href, { headers: address.origin === API && apiKey ? { Authorization: `Bearer ${apiKey}`, Accept: "application/octet-stream", ...headers } : { Accept: "application/octet-stream", ...headers }, redirect: "manual", signal: combinedSignal(signal) });
      if (expectedEtag && (response.status === 412 || response.ok && response.headers.get("etag") !== expectedEtag)) {
        await response.body?.cancel?.(); throw publicError("The selected itch.io file changed. Refresh versions and choose its current upload.");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get("location"); await response.body?.cancel?.();
        if (!target) throw publicError("itch.io did not provide a download address."); address = downloadAddress(target, address.href); continue;
      }
      if (/application\/json/i.test(response.headers.get("content-type") || "")) {
        const value = await responseJson(response); address = downloadAddress(value.url || value.download_url); continue;
      }
      break;
    }
    if (!response?.ok || !response.body || [301, 302, 303, 307, 308].includes(response.status)) throw publicError("itch.io could not start this upload download. Check game access and try again.");
    const contentLength = Number(response.headers.get("content-length")) || null, digest = crypto.createHash("sha256");
    const handle = await fs.promises.open(output, "wx", 0o600); let received = 0;
    try {
      for await (const value of response.body) { signal.throwIfAborted(); const chunk = Buffer.from(value); await handle.writeFile(chunk); digest.update(chunk); received += chunk.length; onProgress(received, contentLength || expectedSize); }
    } finally { await handle.close(); }
    if (contentLength !== null && !response.headers.get("content-encoding") && contentLength !== received || expectedSize && expectedSize !== received) throw publicError("The itch.io download is incomplete. Try downloading this version again.");
    const sha256 = digest.digest("hex"); if (checksum && checksum !== sha256) throw publicError("The itch.io download checksum did not match.");
    return { bytes: received, sha256 };
  }
  async function importCompleted(record) {
    if (record.autoImport && options.onDownloaded) {
      try { await options.onDownloaded(clone(record)); record.imported = true; }
      catch { record.importError = "The download is complete, but no supported game was imported. Import the downloaded file manually to choose its contents."; }
    }
  }
  function download(selection = {}) {
    connected(); const currentGeneration = generation, appId = numeric(selection.appId, "game"), platform = String(selection.platform || "windows");
    if (!["macos", "windows", "linux", "web"].includes(platform)) throw publicError("Choose a supported upload platform.");
    if (selection.destination && (!path.isAbsolute(selection.destination) || /[\x00-\x1f]/.test(selection.destination))) throw publicError("Choose an absolute download folder.");
    const record = { id: crypto.randomUUID(), appId, name: state.library.find(game => game.appId === appId)?.name || `itch.io game ${appId}`, store: "itch", platform,
      branch: String(selection.branch || ""), autoImport: selection.autoImport !== false, imported: false, status: "queued", downloaded: 0, total: null, path: null, detail: "Preparing itch.io download", createdAt: new Date().toISOString() };
    const controller = new AbortController(), signal = controller.signal, job = { record, controller, promise: null }; jobs.set(record.id, job); state.downloads.unshift(record); emit();
    job.promise = (async () => {
      let stage, terminal;
      try {
        record.status = "preparing"; emit(); const catalog = await getVersions(appId, { signal }); assertCurrent(currentGeneration); signal.throwIfAborted();
        const choice = catalog.branches.find(branch => branch.id === record.branch);
        if (!choice) throw publicError("Choose an available itch.io upload and version. Reload versions if the selected build is missing.");
        if (choice.platforms.length && !choice.platforms.includes(platform)) throw publicError("The selected itch.io upload does not match this platform.");
        const exactIdentity = choice.exactIdentity !== false;
        const identity = { store: "itch", appId, platform, versionId: choice.id };
        const existing = exactIdentity ? await checkExistingDownload({ ...identity, userDataDir: options.userDataDir,
          destination: selection.destination, confirmDuplicate: options.confirmDuplicate, signal }) : null;
        signal.throwIfAborted(); assertCurrent(currentGeneration);
        if (existing) {
          record.path = existing.path; record.importPath = existing.importPath || path.join(existing.path, filename(existing.filename, choice.filename));
          record.status = "completed"; record.downloaded = record.total = Number(existing.bytes) || choice.size || null;
          record.reused = true; record.detail = "Using existing download"; record.completedAt = new Date().toISOString(); emit();
          await importCompleted(record); return clone(record);
        }
        let publicDownload;
        if (state.connection.mode === "public") {
          const game = state.library.find(game => game.appId === appId);
          publicDownload = await publicGames.resolveDownload(game, choice, { signal: combinedSignal(signal) });
        } else if (!choice.buildId && choice.revision) {
          const current = await api(`/uploads/${numeric(choice.uploadId, "upload")}`, gameCredentials(appId), signal);
          if (!current.upload || hostedRevision(current.upload) !== choice.revision) throw publicError("This published itch.io file changed after versions were loaded. Reload versions and choose the file again.");
        }
        const parent = selection.destination || path.join(defaultDirectory, appId, platform); fs.mkdirSync(parent, { recursive: true }); const realParent = fs.realpathSync(parent);
        stage = fs.mkdtempSync(path.join(realParent, ".itch-download-"));
        const finalPath = path.join(realParent, `itch-${appId}-${choice.id.replace(/:/g, "-")}-${record.id}`); record.path = finalPath; record.total = choice.size; record.status = "downloading"; record.detail = `Downloading ${choice.name}`; emit();
        const endpoint = publicDownload?.url || (choice.buildId ? `/builds/${numeric(choice.buildId, "build")}/download/archive/default` : `/uploads/${numeric(choice.uploadId, "upload")}/download`);
        let lastEmit = 0;
        const integrity = await transfer(endpoint, publicDownload ? {} : gameCredentials(appId), path.join(stage, choice.filename), { signal, expectedSize: choice.size, checksum: choice.checksum,
          headers: publicDownload?.headers, expectedEtag: publicDownload ? choice.etag : null,
          onProgress: (received, total) => { record.downloaded = received; record.total = total || null; if (Date.now() - lastEmit > 150) { lastEmit = Date.now(); emit(); } } });
        signal.throwIfAborted(); assertCurrent(currentGeneration);
        const metadata = { schema: 1, store: "itch", appId, name: record.name, platform, branch: choice.id, uploadId: choice.uploadId, buildId: choice.buildId, version: choice.version,
          versionId: choice.id, downloadIdentity: exactIdentity ? createDownloadIdentity(identity) : null,
          path: finalPath, importPath: path.join(finalPath, choice.filename), complete: true, createdAt: record.createdAt, filename: choice.filename, ...integrity };
        writeJsonAtomic(path.join(stage, ".maclauncher-external.json"), metadata); fs.renameSync(stage, finalPath); stage = null;
        const indexFile = path.join(options.userDataDir, "external/installations.json"), index = readJson(indexFile, []);
        writeJsonAtomic(indexFile, [...(Array.isArray(index) ? index : []), metadata]);
        record.importPath = path.join(finalPath, choice.filename); record.status = "completed"; record.total = record.downloaded = integrity.bytes; record.detail = "Download complete"; record.completedAt = new Date().toISOString(); emit();
        await importCompleted(record);
      } catch (error) {
        if (signal.aborted || session.signal.aborted || error?.name === "AbortError" || error?.code === "ABORT_ERR") terminal = { status: "cancelled", detail: "Download cancelled" };
        else { const detail = safeError(error, "itch.io could not download this version. Check access and try again."); terminal = { status: "error", error: detail, detail }; }
      } finally {
        try { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }); }
        catch {
          const detail = "The incomplete itch.io download could not be removed. Check the download folder and try again.";
          terminal = { status: "error", error: detail, detail };
        }
        if (terminal) Object.assign(record, terminal);
        jobs.delete(record.id); emit();
      }
      return clone(record);
    })();
    return clone(record);
  }
  function cancel(value) { jobs.get(value)?.controller.abort(); return snapshot(); }
  function markImported(value) { const job = state.downloads.find(item => item.id === value); if (job) { job.imported = true; job.importError = null; emit(); } return snapshot(); }
  function disconnect() { generation++; session.abort(); apiKey = ""; keys.clear(); versions.clear(); publicGames.dispose(); libraryLoading = null; state.libraryLoading = false; for (const job of jobs.values()) job.controller.abort(); state.connection = { status: "disconnected", mode: state.connection.mode === "public" ? "public" : "manual", authUrl: "https://itch.io/user/settings/api-keys" }; emit(); return snapshot(); }
  async function forgetSession() { disconnect(); await options.saveSession?.(null); state.hasSavedKey = false; emit(); return snapshot(); }
  async function dispose() { disposed = true; disconnect(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); }
  return { snapshot, connect, loadLibrary, addGame, getVersions, download, cancel, markImported, disconnect, forgetSession, dispose,
    submitAuth: () => { throw publicError("Connect itch.io with an API key from account settings."); } };
}

module.exports = { createItchStoreDownloads };
