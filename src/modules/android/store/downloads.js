const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto"), https = require("node:https");
const { pipeline } = require("node:stream/promises"), { Transform } = require("node:stream");
const { createPlayProtocol, packageName, versionCode, ARCHITECTURES, ANDROID_SDKS } = require("./protocol");
const { readApkIdentity } = require("./apk-identity");
const { writeJsonAtomic } = require("../../../core/json-files");
const { checkExistingDownload, createDownloadIdentity } = require("../../../core/external-download-duplicates");
const { reuseCompletedDownload } = require("../../../core/external-download-reuse");
const clone = value => JSON.parse(JSON.stringify(value));
const readJson = (file, fallback = null) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const publicError = message => Object.assign(new Error(message), { playPublic: true });
const safeError = error => error?.playPublic || error?.googlePlayPublic ? error.message : error?.code === "ENOSPC" ? "There is not enough space for this download." : "Google Play could not complete this action. Check the account, network and selected app version.";
const cancelled = error => error?.name === "AbortError" || error?.code === "ABORT_ERR";
const validSession = value => value && (value.mode === "microg" && typeof value.microgAccountId === "string" && value.microgAccountId.length > 0 || typeof value.email === "string" && value.email.includes("@") && typeof value.aasToken === "string" && value.aasToken.length > 5);
const libraryNote = "The account list comes from Google Play purchase history. Free apps can also be found with Search; Google Play may omit some earlier acquisitions.";
function allowedDownload(url) { const value = new URL(url); if (value.protocol !== "https:" || !/(?:^|\.)(?:google\.com|googleapis\.com|googleusercontent\.com|gvt1\.com|ggpht\.com)$/.test(value.hostname)) throw publicError("Google Play supplied an unsupported download address."); return value; }
async function downloadPlayFile(item, output, { signal, onBytes } = {}) {
  const initial = allowedDownload(item.url), hashes = { sha256: crypto.createHash("sha256"), sha1: crypto.createHash("sha1") };
  let received = 0;
  async function open(url, redirects = 0) {
    signal?.throwIfAborted(); const target = allowedDownload(url); if (redirects > 5) throw publicError("Google Play returned too many download redirects.");
    const cookie = target.origin === initial.origin ? (item.cookies || []).filter(value => /^[a-zA-Z0-9_.-]+$/.test(value.name) && !/[\r\n;]/.test(value.value)).map(value => `${value.name}=${value.value}`).join("; ") : "";
    const response = await new Promise((resolve, reject) => { const req = https.get(target, { signal, headers: cookie ? { Cookie: cookie } : {}, timeout: 30000 }, resolve); req.on("timeout", () => req.destroy(publicError("Google Play download timed out."))); req.on("error", reject); });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) { const location = response.headers.location; response.destroy(); if (!location) throw publicError("Google Play returned an incomplete download redirect."); return open(new URL(location, target).href, redirects + 1); }
    if (response.statusCode !== 200) { response.destroy(); throw publicError(`Google Play download failed (HTTP ${response.statusCode}). Refresh the app and try again.`); }
    return response;
  }
  const response = await open(initial.href); fs.mkdirSync(path.dirname(output), { recursive: true });
  const meter = new Transform({ transform(bytes, _encoding, done) { received += bytes.length; if (item.size && received > item.size) return done(publicError("A Google Play file exceeded its declared size.")); hashes.sha256.update(bytes); hashes.sha1.update(bytes); onBytes?.(bytes.length); done(null, bytes); } });
  await pipeline(response, meter, fs.createWriteStream(output, { flags: "wx", mode: 0o600 }), ...(signal ? [{ signal }] : []));
  const sha256 = hashes.sha256.digest("hex"), sha1 = hashes.sha1.digest("hex");
  if (item.size && item.size !== received || item.sha256 && item.sha256 !== sha256 || item.sha1 && item.sha1 !== sha1) throw publicError("A Google Play file failed its integrity check. Download it again.");
  return { size: received, sha256, sha1 };
}
function createGooglePlayDownloads(options = {}) {
  if (!path.isAbsolute(options.userDataDir || "")) throw Error("A MacLauncher profile directory is required.");
  const root = path.join(options.userDataDir, "external", "google-play"), defaultDirectory = path.join(options.userDataDir, "external", "downloads", "google-play"), cacheFile = path.join(root, "library.json"), cached = readJson(cacheFile);
  const state = { connection: { status: "disconnected", accountName: cached?.email || "" }, library: cached?.library || [], libraryLoading: false, libraryError: null, libraryFetchedAt: cached?.fetchedAt || null,
    libraryNote, hasSavedSession: false, capabilities: { search: true, ownedLibrary: true }, downloads: [], defaultDirectory };
  const protocol = options.protocol || createPlayProtocol(options), jobs = new Map(), catalog = new Map(), observations = new Map(), entries = new Map(state.library.map(row => [row.appId, row]));
  let session, disposed = false, generation = 0, pendingConnect, activeLibrary, libraryAccount = cached?.email, lifetime = new AbortController();
  const snapshot = () => clone(state), emit = () => { if (!disposed) options.onChange?.(snapshot()); };
  const savedReady = Promise.resolve().then(() => options.loadSession?.()).then(value => { if (generation === 0 && validSession(value) && !session && !disposed) { session = value; state.hasSavedSession = true; state.connection.accountName = value.email; emit(); } }).catch(() => {});
  const connected = () => { if (disposed || state.connection.status !== "connected" || !validSession(session)) throw publicError("Connect a Google account to continue."); };
  const persist = async () => { if (session?.remember !== false) { const saved = session.mode === "microg" ? { ...session, auths: undefined, authToken: undefined, aasToken: undefined } : session; await options.saveSession?.(clone(saved)); state.hasSavedSession = true; } };
  const combine = signal => signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  async function authorization(architecture = "arm64", language = "en-US", { signal, refresh = false, androidSdk = 34 } = {}) {
    signal = combine(signal); signal.throwIfAborted(); const current = generation;
    androidSdk = Number(androidSdk); if (!ANDROID_SDKS.includes(androidSdk)) throw publicError("Choose an Android SDK level from 21 to 36.");
    const key = `${architecture}:${androidSdk}:${language.toLowerCase()}`, previousKey = `${architecture}:${language.toLowerCase()}`;
    session.devices ||= {}; session.auths ||= {};
    let registration = session.devices[key] || (session.devices[previousKey]?.device?.sdk === androidSdk ? session.devices[previousKey] : null);
    if (!registration) { registration = await protocol.prepareDevice({ architecture, locale: language, androidSdk, signal }); if (current !== generation) throw publicError("The Google account changed."); }
    session.devices[key] = registration;
    let auth = session.auths[key] || (session.auths[previousKey]?.device?.sdk === androidSdk ? session.auths[previousKey] : null);
    if (refresh || !auth || auth.expiresAt < Date.now() + 30000) {
      let credentials = session;
      if (session.mode === "microg") {
        const login = options.microgLogin || options.microgGetToken;
        if (!login) throw publicError("The Google account provider is unavailable. Choose an available account or browser sign-in.");
        credentials = await login({ accountId: session.microgAccountId, refresh, signal }); signal.throwIfAborted();
        if (!credentials?.authToken || !credentials.email) throw publicError("The Google account provider did not return a Play session.");
        session.email = credentials.email;
      }
      auth = await protocol.authorize(credentials, registration, { signal }); if (current !== generation) throw publicError("The Google account changed."); session.auths[key] = auth; await persist();
    }
    return auth;
  }
  async function withAuth(architecture, language, signal, operation, androidSdk = 34) {
    const auth = await authorization(architecture, language, { signal, androidSdk });
    try { return await operation(auth, combine(signal)); }
    catch (error) { if (!error.authExpired) throw error; const fresh = await authorization(architecture, language, { signal, refresh: true, androidSdk }); return operation(fresh, combine(signal)); }
  }
  async function connect(credentials = {}) {
    if (pendingConnect) { options.focusBrowserLogin?.(); return pendingConnect; }
    if (disposed) throw publicError("The Google Play window has closed.");
    pendingConnect = (async () => {
      await savedReady; const current = ++generation; lifetime.abort(); lifetime = new AbortController(); const signal = lifetime.signal;
      state.connection = { status: "connecting", accountName: session?.email || "",
        mode: credentials.mode === "reuse" ? session?.mode || "browser" : credentials.mode === "microg" ? "microg" : "browser" }; state.libraryError = null; emit();
      try {
        if (credentials.mode !== "reuse" && credentials.remember === false) {
          state.hasSavedSession = false;
          await options.saveSession?.(null);
          if (validSession(session) && session.mode !== "microg") await options.clearBrowserAccount?.(session.browserAccountId || "default");
          signal.throwIfAborted(); emit();
        }
        if (credentials.mode === "microg") {
          const accountId = String(credentials.accountId || session?.microgAccountId || "");
          if (!accountId) throw publicError("Choose a Google account from the account provider.");
          if (session?.microgAccountId !== accountId) { state.library = []; state.libraryFetchedAt = null; entries.clear(); catalog.clear(); }
          session = { mode: "microg", microgAccountId: accountId, remember: credentials.remember !== false, devices: {}, auths: {} };
        } else if (credentials.mode !== "reuse") {
          if (typeof options.browserLogin !== "function") throw publicError("Google account sign-in is unavailable.");
          const registration = await protocol.prepareDevice({ architecture: "arm64", locale: "en-US", signal });
          const requestedBrowserAccountId = crypto.randomUUID(), login = await options.browserLogin({ signal, androidId: registration.androidId, accountId: requestedBrowserAccountId, remember: credentials.remember !== false });
          signal.throwIfAborted(); if (!validSession(login)) throw publicError("Google did not return an authenticated account.");
          if (session?.email !== login.email) { state.library = []; state.libraryFetchedAt = null; entries.clear(); catalog.clear(); }
          session = { ...login, mode: "browser", browserAccountId: login.browserAccountId || requestedBrowserAccountId, remember: credentials.remember !== false, devices: { "arm64:34:en-us": registration }, auths: {} };
        } else if (!validSession(session)) throw publicError("No saved Google account is available. Choose browser sign-in.");
        await authorization("arm64", "en-US", { signal }); signal.throwIfAborted(); if (current !== generation) return snapshot();
        if (libraryAccount !== session.email) { state.library = []; state.libraryFetchedAt = null; entries.clear(); catalog.clear(); }
        await persist(); state.connection = { status: "connected", accountName: session.email, displayName: session.email, mode: session.mode || "browser", accountId: session.mode === "microg" ? session.microgAccountId : session.sharedAccountId || session.browserAccountId }; emit();
        await loadLibrary({ refresh: true }).catch(() => {}); return snapshot();
      } catch (error) { if (current === generation) { state.connection = { status: cancelled(error) || signal.aborted ? "disconnected" : "error", accountName: session?.email || "", ...(cancelled(error) || signal.aborted ? {} : { error: safeError(error) }) }; emit(); } throw error?.playPublic || error?.googlePlayPublic || cancelled(error) ? error : publicError(safeError(error)); }
      finally { pendingConnect = null; }
    })();
    return pendingConnect;
  }
  async function loadLibrary({ refresh = false } = {}) {
    connected(); if (activeLibrary) return activeLibrary; if (!refresh && state.libraryFetchedAt) return clone(state.library);
    const current = generation, signal = lifetime.signal; state.libraryLoading = true; state.libraryError = null; emit();
    activeLibrary = (async () => {
      try {
        const result = await withAuth("arm64", "en-US", signal, (auth, signal) => protocol.library(auth, { signal }));
        if (current !== generation) throw publicError("The Google account changed.");
        const acquired = libraryAccount === session.email ? state.library.filter(row => row.licenseSource === "google-play-acquisition") : [];
        state.library = [...new Map([...acquired, ...result.library.map(row => ({ ...row, owned: true }))].map(row => [row.appId, row])).values()]; libraryAccount = session.email;
        state.libraryFetchedAt = new Date().toISOString(); state.libraryTruncated = result.truncated;
        for (const row of state.library) entries.set(row.appId, row);
        writeJsonAtomic(cacheFile, { email: session.email, fetchedAt: state.libraryFetchedAt, library: state.library }); return clone(state.library);
      } catch (error) { if (current === generation) state.libraryError = safeError(error); throw publicError(safeError(error)); }
      finally { if (current === generation) { activeLibrary = null; state.libraryLoading = false; emit(); } }
    })(); return activeLibrary;
  }
  async function search(query, { architecture = "arm64", language = "en-US", androidSdk = 34, signal } = {}) {
    connected(); const current = generation;
    const result = await withAuth(architecture, language, signal, (auth, signal) => protocol.search(auth, query, { signal }), androidSdk);
    if (current !== generation) throw publicError("The Google account changed.");
    return result.map(row => { const owned = state.library.some(item => item.appId === row.appId), value = { ...row, owned, canAddToLibrary: !owned && row.priceMicros === "0" && !row.checkoutRequired }; entries.set(row.appId, value); return clone(value); });
  }
  async function getVersions(value, { refresh = false, architecture = "arm64", language = "en-US", androidSdk = 34, sdk, signal } = {}) {
    androidSdk = Number(sdk ?? androidSdk);
    connected(); const appId = packageName(value), key = `${appId}:${architecture}:${androidSdk}:${language}`, current = generation;
    if (!refresh && catalog.has(key)) return clone(catalog.get(key));
    let detail, unavailableReason;
    try { detail = await withAuth(architecture, language, signal, (auth, signal) => protocol.details(auth, appId, { signal }), androidSdk); }
    catch (error) { if (!error.unavailable) throw error; unavailableReason = safeError(error); }
    if (current !== generation) throw publicError("The Google account changed.");
    const owned = state.library.some(row => row.appId === appId);
    if (detail) entries.set(appId, { ...detail, owned, canAddToLibrary: !owned && detail.priceMicros === "0" && !detail.checkoutRequired });
    const observationsKey = `${appId}:${androidSdk}:${language}`, available = !!detail;
    if (!observations.has(observationsKey)) observations.set(observationsKey, new Map());
    const observed = observations.get(observationsKey); observed.set(architecture, { available, reason: unavailableReason });
    const supportedArchitectures = detail?.supportedArchitectures || [];
    const result = { appId, name: detail?.name || entries.get(appId)?.name || appId, app: entries.get(appId) || null, platforms: ["android"], available, unavailableReason,
      profile: { architecture, androidSdk, sdk: androidSdk }, sdkVersions: ANDROID_SDKS,
      deviceProfiles: ARCHITECTURES.map(value => ({ architecture: value, androidSdk, sdk: androidSdk, label: { arm64: "ARM64", armv7: "ARM 32-bit", x86_64: "x86-64", x86: "x86 32-bit" }[value], available: observed.get(value)?.available ?? null, reason: observed.get(value)?.reason })),
      branches: detail ? [{ id: detail.versionCode, buildId: detail.versionCode, versionCode: detail.versionCode, name: detail.versionName || `Version ${detail.versionCode}`, platforms: ["android"], architectures: [architecture], androidSdk, updatedAt: detail.updatedAt, passwordRequired: false }] : [],
      depots: [], history: [], architectures: [...new Set([...supportedArchitectures, ...[...observed].filter(([, value]) => value.available).map(([key]) => key)])], supportedArchitectures, languages: [language], supportsVersionCode: true, splits: detail?.splits || [],
      historyNote: "Google Play supplies the current version for the selected architecture and Android SDK level. Other profiles are checked when selected. Split metadata identifies native ABIs when supplied. A known earlier version code can be requested; availability depends on account, region and device compatibility. Required APK splits are included automatically." };
    catalog.set(key, result); return clone(result);
  }
  async function addToLibrary(value, { architecture = "arm64", language = "en-US", androidSdk = 34, signal } = {}) {
    connected(); const appId = packageName(value), current = generation;
    const detail = await withAuth(architecture, language, signal, (auth, signal) => protocol.details(auth, appId, { signal }), androidSdk);
    if (detail.priceMicros !== "0" || detail.checkoutRequired) throw publicError("Only apps confirmed free by Google Play can be added here. Paid apps must be purchased in Google Play.");
    const result = await withAuth(architecture, language, signal, (auth, signal) => protocol.acquire(auth, detail, detail.versionCode, { signal }), androidSdk);
    if (current !== generation) throw publicError("The Google account changed.");
    if (result?.licensed !== true || result.appId && result.appId !== appId) throw publicError("Google Play did not confirm adding this app to the account.");
    const row = { ...detail, owned: true, canAddToLibrary: false, licenseSource: "google-play-acquisition", licensedAt: new Date().toISOString() };
    state.library = [...state.library.filter(item => item.appId !== appId), row].sort((a, b) => a.name.localeCompare(b.name)); entries.set(appId, row);
    libraryAccount = session.email; state.libraryFetchedAt = new Date().toISOString(); writeJsonAtomic(cacheFile, { email: session.email, fetchedAt: state.libraryFetchedAt, library: state.library }); catalog.clear(); emit(); return snapshot();
  }
  function download(selection = {}) {
    connected(); const appId = packageName(selection.appId), architecture = selection.architecture || "arm64", language = selection.language || "en-US", androidSdk = Number(selection.androidSdk ?? selection.sdk ?? 34);
    if (!ARCHITECTURES.includes(architecture)) throw publicError("Choose a supported Android architecture.");
    if (selection.destination && (!path.isAbsolute(selection.destination) || /[\x00-\x1f]/.test(selection.destination))) throw publicError("Choose an absolute download folder.");
    const code = versionCode(selection.versionCode || selection.branch), includeExtras = selection.includeExtras !== false, current = generation;
    if (!ANDROID_SDKS.includes(androidSdk)) throw publicError("Choose an Android SDK level from 21 to 36.");
    const record = { id: crypto.randomUUID(), store: "google-play", appId, name: String(selection.name || entries.get(appId)?.name || appId), platform: "android", architecture, androidSdk, language, branch: code, versionCode: code, buildId: code,
      autoImport: selection.autoImport !== false, imported: false, includeExtras, status: "queued", downloaded: 0, total: null, path: null, detail: "Preparing download", createdAt: new Date().toISOString() };
    const controller = new AbortController(), signal = combine(controller.signal), holder = { record, controller }; jobs.set(record.id, holder); state.downloads.unshift(record); emit();
    holder.promise = (async () => {
      let stage, terminalStatus;
      try {
        record.status = "preparing"; emit();
        const versionId = `${code}:${architecture}:sdk${androidSdk}:${language.toLowerCase()}:${includeExtras ? "full" : "apk"}`, duplicateRequest = { userDataDir: options.userDataDir, store: "google-play", appId, platform: "android", versionId, destination: selection.destination, confirmDuplicate: options.confirmDuplicate, signal };
        record.versionId = versionId; record.downloadIdentity = createDownloadIdentity(duplicateRequest);
        const existing = await checkExistingDownload(duplicateRequest); signal.throwIfAborted(); if (existing) return await reuseCompletedDownload(record, existing, { signal, onChange: emit, onDownloaded: options.onDownloaded });
        let detail;
        try { detail = await withAuth(architecture, language, signal, (auth, signal) => protocol.details(auth, appId, { signal }), androidSdk); }
        catch (error) { if (!error.unavailable) throw error; detail = { ...entries.get(appId), appId, offerType: 1, versionCode: null }; }
        record.versionName = detail.versionCode === code ? detail.versionName || `Version ${code}` : `Version code ${code}`; record.version = record.versionName;
        const delivery = await withAuth(architecture, language, signal, (auth, signal) => protocol.delivery(auth, detail, code, { signal }), androidSdk);
        if (String(delivery.versionCode) !== code || delivery.appId !== appId) throw publicError("Google Play returned a different app version than requested.");
        const files = delivery.files.filter(file => includeExtras || ["base", "split"].includes(file.type));
        if (files.filter(file => file.type === "base").length !== 1) throw publicError("Google Play did not provide one base APK.");
        const parent = path.resolve(selection.destination || path.join(defaultDirectory, appId, architecture)); fs.mkdirSync(parent, { recursive: true, mode: 0o700 }); const realParent = fs.realpathSync(parent);
        stage = fs.mkdtempSync(path.join(realParent, ".google-play-download-")); const finalPath = path.join(realParent, `${code}-${record.id}`); record.path = finalPath; record.importPath = path.join(finalPath, "base.apk");
        record.total = files.reduce((sum, file) => sum + (file.size || 0), 0) || null; record.status = "downloading"; emit();
        const completed = []; let lastEmit = 0;
        for (const file of files) {
          signal.throwIfAborted(); const output = path.resolve(stage, file.filename), relative = path.relative(stage, output);
          if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || /[\\\x00-\x1f]/.test(file.filename)) throw publicError("Google Play supplied an unsafe file path.");
          record.detail = file.filename; emit();
          const verified = await (options.downloadFile || downloadPlayFile)(file, output, { signal, onBytes: bytes => { record.downloaded += bytes; if (Date.now() - lastEmit > 150) { lastEmit = Date.now(); emit(); } } });
          if (["base", "split", "asset"].includes(file.type)) {
            const identity = (options.readApkIdentity || readApkIdentity)(output);
            if (identity.packageName !== appId || identity.versionCode !== code || file.type === "base" && identity.split) throw publicError("A downloaded APK does not match the requested package and exact version code.");
          }
          completed.push({ filename: file.filename, type: file.type, size: verified.size, sha256: verified.sha256 });
        }
        signal.throwIfAborted(); if (current !== generation) throw publicError("The Google account changed.");
        const metadata = { schema: 1, store: "google-play", appId, name: record.name, platform: "android", architecture, androidSdk, language, includeExtras, versionCode: code, buildId: code, version: record.versionName, versionName: record.versionName, versionId, downloadIdentity: record.downloadIdentity,
          path: finalPath, importPath: record.importPath, complete: true, files: completed, createdAt: record.createdAt };
        writeJsonAtomic(path.join(stage, ".maclauncher-external.json"), metadata); fs.renameSync(stage, finalPath); stage = null;
        const indexFile = path.join(options.userDataDir, "external/installations.json"), index = readJson(indexFile, []); writeJsonAtomic(indexFile, [...(Array.isArray(index) ? index : []), metadata]);
        record.status = "completed"; record.detail = "Download complete"; record.completedAt = new Date().toISOString(); emit();
        if (record.autoImport && options.onDownloaded) { try { await options.onDownloaded(clone(record)); record.imported = true; } catch { record.importError = "The download is complete, but the Android package could not be imported. Import base.apk manually."; } }
      } catch (error) { terminalStatus = signal.aborted || cancelled(error) ? "cancelled" : "error"; record.detail = terminalStatus === "cancelled" ? "Download cancelled" : safeError(error); if (terminalStatus === "error") record.error = record.detail; }
      finally { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }); if (terminalStatus) record.status = terminalStatus; jobs.delete(record.id); emit(); }
      return clone(record);
    })(); return clone(record);
  }
  function markImported(id) { const record = state.downloads.find(row => row.id === id); if (record) { record.imported = true; record.importError = null; emit(); } return snapshot(); }
  function cancel(id) { jobs.get(id)?.controller.abort(); return snapshot(); }
  async function disconnect({ forget = false } = {}) {
    generation++; lifetime.abort(); options.cancelBrowserLogin?.(); activeLibrary = null; state.libraryLoading = false;
    if (forget) { const accountId = session?.mode === "microg" ? null : session?.browserAccountId || "default"; session = null; state.hasSavedSession = false; state.library = []; state.libraryFetchedAt = null; entries.clear(); catalog.clear(); state.connection = { status: "disconnected", accountName: "" }; emit(); await options.saveSession?.(null); if (accountId) await options.clearBrowserAccount?.(accountId); }
    state.connection = { status: "disconnected", accountName: session?.email || "" }; emit(); return snapshot();
  }
  async function dispose() { disposed = true; await disconnect(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); }
  return { snapshot, connect, loadLibrary, search, getVersions, addToLibrary, download, markImported, cancel, disconnect, dispose, forgetSession: () => disconnect({ forget: true }),
    openLogin: () => { options.focusBrowserLogin?.(); return snapshot(); }, submitAuth: () => { throw publicError("Complete sign-in in the Google account window."); } };
}
module.exports = { createGooglePlayDownloads, downloadPlayFile, libraryNote };
