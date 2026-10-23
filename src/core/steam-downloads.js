const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), crypto = require("node:crypto");
const { setTimeout: delay } = require("node:timers/promises");
const { reuseCompletedDownload } = require("./external-download-reuse");
const { ARCHITECTURES, architectureConfig, matchesSteamArchitecture, steamArchitectureCatalog, steamLibraryArchitectures } = require("./steam-architectures");

const PLATFORMS = ["macos", "windows", "linux"];
const HISTORY_NOTE = "Steam lists current publisher branches. Earlier manifests appear after they have been observed; a known depot and manifest ID can also be entered. Steam may restrict access to older or shared content.";
const clone = value => JSON.parse(JSON.stringify(value));
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
function numericId(value, label = "Steam app") {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]{0,9}$/.test(text) || Number(text) > 0xffffffff) throw new Error(`Invalid ${label} ID.`);
  return Number(text);
}
function manifestId(value) {
  const text = String(value ?? "");
  if (!/^[1-9][0-9]{0,19}$/.test(text) || BigInt(text) > 0xffffffffffffffffn) throw new Error("Invalid Steam manifest ID.");
  return text;
}
function platforms(value) { return String(value || "").toLowerCase().split(/[,;\s]+/).map(item => item === "mac" ? "macos" : item).filter(item => PLATFORMS.includes(item)); }
function splitValues(value) { return String(value || "").split(/[,;\s]+/).filter(Boolean); }
function safeError(error, fallback = "Steam could not complete this action.") {
  // Account details, cookies and tokens from the protocol are never renderer errors.
  const code = Number(error?.eresult);
  const reasons = { 5: "Steam account name or password was not accepted.", 15: "Steam access was denied. Check ownership and the selected depot or manifest.",
    16: "Steam timed out. Try the action again.", 20: "Steam is unavailable. Try again later.", 63: "Steam Guard requires another sign-in attempt.",
    65: "Steam Guard code was not accepted.", 84: "Steam has limited sign-in attempts. Try again later.", 88: "Steam Guard code was not accepted.",
    106: "Steam access was denied for the selected game." };
  if (reasons[code]) return reasons[code];
  if (error?.steamPublic === true) return error.message;
  if (error?.code === "ENOSPC") return "There is not enough space for this download.";
  if (error?.code === "EACCES" || error?.code === "EPERM") return "The selected download folder cannot be written.";
  return fallback;
}
function publicError(message) { return Object.assign(new Error(message), { steamPublic: true }); }
function localAccount(homeDir = os.homedir()) {
  try {
    const { parseSteamVdf } = require("./steam-installed-games");
    const users = parseSteamVdf(fs.readFileSync(path.join(homeDir, "Library/Application Support/Steam/config/loginusers.vdf"), "utf8")).users;
    const row = Object.values(users || {}).find(item => item.MostRecent === "1");
    return row ? { accountName: row.AccountName || "", displayName: row.PersonaName || row.AccountName || "" } : null;
  } catch { return null; }
}
function normalizeVersions(appId, appinfo, previous = []) {
  const info = appinfo || {}, common = info.common || {}, source = info.depots || {};
  const branches = Object.entries(source.branches || {}).map(([id, branch]) => ({ id, name: id === "public" ? "Public" : id,
    description: branch.description || "", buildId: String(branch.buildid || ""), updatedAt: Number(branch.timeupdated) ? new Date(Number(branch.timeupdated) * 1000).toISOString() : null,
    passwordRequired: String(branch.pwdrequired || "0") === "1" }));
  if (!branches.some(item => item.id === "public")) branches.unshift({ id: "public", name: "Public", description: "", buildId: "", updatedAt: null, passwordRequired: false });
  const observedAt = new Date().toISOString(), history = new Map(previous.map(item => [`${item.depotId}:${item.manifestId}:${item.branch || ""}`, item]));
  const depots = Object.entries(source).filter(([id, depot]) => /^[1-9]\d*$/.test(id) && depot && typeof depot === "object").map(([id, depot]) => {
    const manifests = {};
    for (const [branch, value] of Object.entries(depot.manifests || {})) {
      const record = typeof value === "object" ? value : { gid: value };
      try {
        manifests[branch] = { id: manifestId(record.gid), size: Number(record.size) || null, downloadSize: Number(record.download) || null };
        const entry = { depotId: Number(id), manifestId: manifests[branch].id, branch, observedAt };
        const key = `${id}:${entry.manifestId}:${branch}`; if (!history.has(key)) history.set(key, entry);
      } catch {}
    }
    return { id: Number(id), name: depot.name || `Depot ${id}`, platforms: platforms(depot.config?.oslist),
      ...architectureConfig(depot.config), languages: splitValues(depot.config?.language), manifests,
      encryptedBranches: Object.keys(depot.encryptedmanifests || {}), requiresAppId: Number(depot.dlcappid) || null,
      depotFromAppId: Number(depot.depotfromapp) || null };
  });
  return { appId, name: common.name || `App ${appId}`, platforms: platforms(common.oslist), branches, depots, ...steamArchitectureCatalog(info, depots),
    history: [...history.values()].slice(-500), historyNote: HISTORY_NOTE };
}
function describeSteamSelection(branch, branchInfo, choices) {
  const manifestSetId = crypto.createHash("sha256").update(JSON.stringify(choices.map(item => [item.depot.id, item.manifestId]))).digest("hex").slice(0, 12);
  const matchesBranch = choices.every(item => item.currentManifest === true || item.manifestId === item.depot.manifests?.[branch]?.id);
  const buildId = matchesBranch && branchInfo.buildId ? branchInfo.buildId : null;
  const versionName = buildId ? `Build ${buildId}` : choices.length === 1 ? `Manifest ${choices[0].manifestId}` : `Manifests ${manifestSetId}`;
  return { manifestSetId, buildId, versionName };
}

// Steam Families' CM service extends the shared licenses supplied by SteamUser.
// Field numbers: https://github.com/SteamDatabase/Protobufs/blob/master/steam/steammessages_familygroups.steamclient.proto
// Only membership and shared-library metadata are requested; no family mutations.
function varint(value) { let n = BigInt(value), bytes = []; do { let b = Number(n & 127n); n >>= 7n; bytes.push(b | (n ? 128 : 0)); } while (n); return Buffer.from(bytes); }
function protoField(id, value, type = 0) {
  const head = varint((id << 3) | type);
  if (type === 1) { const out = Buffer.alloc(8); out.writeBigUInt64LE(BigInt(value)); return Buffer.concat([head, out]); }
  if (type === 2) { const bytes = Buffer.from(value); return Buffer.concat([head, varint(bytes.length), bytes]); }
  return Buffer.concat([head, varint(value)]);
}
function protoFields(input) {
  const data = Buffer.isBuffer(input) ? input : input.toBuffer(), fields = new Map(); let offset = 0;
  const number = () => { let n = 0n, shift = 0n; do { if (offset >= data.length || shift > 70n) throw new Error("Invalid Steam response."); const b = data[offset++]; n |= BigInt(b & 127) << shift; if (!(b & 128)) return n; shift += 7n; } while (true); };
  while (offset < data.length) {
    const tag = Number(number()), id = tag >>> 3, wire = tag & 7; let value;
    if (!id) throw new Error("Invalid Steam response.");
    if (wire === 0) value = number().toString();
    else if (wire === 1) { if (offset + 8 > data.length) throw new Error("Invalid Steam response."); value = data.readBigUInt64LE(offset).toString(); offset += 8; }
    else if (wire === 2) { const length = Number(number()); if (!Number.isSafeInteger(length) || offset + length > data.length) throw new Error("Invalid Steam response."); value = data.subarray(offset, offset + length); offset += length; }
    else if (wire === 5) { if (offset + 4 > data.length) throw new Error("Invalid Steam response."); value = data.readUInt32LE(offset); offset += 4; }
    else throw new Error("Invalid Steam response.");
    if (!fields.has(id)) fields.set(id, []); fields.get(id).push(value);
  }
  return fields;
}
function familyRpc(client, method, body) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(publicError("Steam family library could not be loaded. Refresh to try again.")), 15000); timer.unref?.();
    try {
      client._send({ msg: 151, proto: { target_job_name: `FamilyGroups.${method}#1` } }, body, (response, header) => {
        clearTimeout(timer);
        if (header.proto?.eresult !== 1) return reject(Object.assign(new Error("Steam family request failed."), { eresult: header.proto?.eresult }));
        try { resolve(protoFields(response)); } catch (error) { reject(error); }
      });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}
async function sharedLibrary(client) {
  if (typeof client.getSharedLibraryApps === "function") return client.getSharedLibraryApps();
  const membership = await familyRpc(client, "GetFamilyGroupForUser", protoField(1, client.steamID.getSteamID64()));
  const group = membership.get(1)?.[0];
  if (!group || group === "0") return [];
  const result = await familyRpc(client, "GetSharedLibraryApps", Buffer.concat([protoField(1, group, 1), protoField(2, 1), protoField(3, 0), protoField(5, "english", 2), protoField(7, 0)]));
  return (result.get(1) || []).map(bytes => {
    const app = protoFields(bytes);
    return { appId: Number(app.get(1)?.[0]), name: app.get(6)?.[0]?.toString("utf8") || "", owners: app.get(2) || [],
      iconHash: app.get(9)?.[0]?.toString("utf8"), excluded: Number(app.get(10)?.[0] || 0) !== 0 };
  }).filter(app => app.appId > 0 && !app.excluded);
}
function containedFile(root, filename) {
  const relative = String(filename || "").replace(/\\/g, "/");
  if (!relative || relative.includes("\0") || /^(?:\/|[a-z]:)/i.test(relative) || relative.split("/").some(part => part === ".." || part === "." || !part))
    throw publicError("Steam supplied an unsafe file path.");
  const output = path.resolve(root, relative);
  if (!output.startsWith(`${root}${path.sep}`)) throw publicError("Steam supplied an unsafe file path.");
  return output;
}
function checkParent(root, file) {
  let current = path.dirname(file);
  while (current !== root) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw publicError("Steam supplied conflicting file paths.");
    current = path.dirname(current);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason || new Error("Cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
async function transferFile(client, appId, depotId, file, output, { signal, servers, onBytes }) {
  const size = Number(file.size);
  if (!Number.isSafeInteger(size) || size < 0) throw publicError("The Steam file size is unsupported.");
  checkParent(path.parse(output).root, output);
  const stat = fs.lstatSync(output, { throwIfNoEntry: false });
  if (stat && !stat.isFile()) throw publicError("Steam supplied conflicting file paths.");
  const handle = await fs.promises.open(output, stat ? "w" : "wx", (Number(file.flags) & 32) ? 0o755 : 0o644);
  const chunks = file.chunks || []; let cursor = 0, failed;
  try {
    await handle.truncate(size);
    await Promise.allSettled(Array.from({ length: Math.min(4, chunks.length) }, async (_, worker) => {
      while (!failed) {
        signal.throwIfAborted(); const chunk = chunks[cursor++]; if (!chunk) return;
        let bytes, lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          signal.throwIfAborted();
          try { ({ chunk: bytes } = await abortable(client.downloadChunk(appId, depotId, chunk.sha, servers[(worker + attempt) % servers.length]), signal)); break; }
          catch (error) { lastError = error; if (signal.aborted) throw error; if (attempt < 2) await delay(200 * (attempt + 1), undefined, { signal }); }
        }
        if (!bytes) throw lastError;
        const offset = Number(chunk.offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > size || crypto.createHash("sha1").update(bytes).digest("hex") !== String(chunk.sha).toLowerCase())
          throw publicError("A Steam download chunk failed its integrity check.");
        signal.throwIfAborted(); let written = 0;
        while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, offset + written)).bytesWritten;
        onBytes(bytes.length);
      }
    }).map(promise => promise.catch(error => { failed = error; throw error; })));
    if (failed) throw failed;
  } finally { await handle.close(); }
  signal.throwIfAborted();
  if (size > 0) {
    const hash = crypto.createHash("sha1");
    for await (const bytes of fs.createReadStream(output)) { signal.throwIfAborted(); hash.update(bytes); }
    if (hash.digest("hex") !== String(file.sha_content).toLowerCase()) throw publicError("A Steam download file failed its integrity check.");
  }
  await fs.promises.chmod(output, (Number(file.flags) & 32) ? 0o755 : 0o644);
}

function createSteamDownloads(options = {}) {
  if (!path.isAbsolute(options.userDataDir || "")) throw new Error("A MacLauncher profile directory is required.");
  const root = path.join(options.userDataDir, "steam"), defaultDirectory = path.join(options.userDataDir, "external", "downloads", "steam");
  const namedAccount = String(options.accountName || "").trim();
  const metadataRoot = namedAccount ? path.join(root, "accounts", crypto.createHash("sha256").update(namedAccount.toLowerCase()).digest("hex").slice(0, 24)) : root;
  const accountHint = namedAccount ? { accountName: namedAccount, displayName: namedAccount } : localAccount(options.homeDir), cache = readJson(path.join(metadataRoot, "library.json"), null);
  const state = { connection: { status: "disconnected", accountName: accountHint?.accountName || cache?.accountName || "", displayName: accountHint?.displayName || "" },
    library: cache?.library || [], libraryLoading: false, libraryFetchedAt: cache?.architectureSchema === 1 ? cache.fetchedAt || null : null, libraryError: null, downloads: [], defaultDirectory };
  let client, authSession, authDeadline, ownershipReady, resolveOwnership, rejectOwnership, guardCallback, remember = false, disposed = false, activeLibrary = null, loadedAccount = cache?.accountName, accountGeneration = 0;
  const jobs = new Map(), versionCache = new Map();
  const emit = () => { if (!disposed) options.onChange?.(snapshot()); };
  const snapshot = () => clone(state);
  const connected = () => { if (state.connection.status !== "connected" || !client) throw publicError("Connect a Steam account to continue."); return client; };
  function cancelAuthentication() {
    clearTimeout(authDeadline); authDeadline = null;
    if (authSession) {
      authSession.cancelLoginAttempt(); authSession.removeAllListeners(); authSession.on("error", () => {}); authSession = null;
    }
  }
  function detach() {
    accountGeneration++; activeLibrary = null;
    cancelAuthentication();
    guardCallback = null; rejectOwnership?.(publicError("The Steam account changed.")); if (client) { client.logOff(); client.removeAllListeners(); client.on("error", () => {}); client = null; }
    resolveOwnership = rejectOwnership = null;
  }
  function disconnect() {
    for (const job of jobs.values()) job.controller.abort();
    detach(); state.connection = { status: "disconnected", accountName: state.connection.accountName || "" }; emit(); return snapshot();
  }
  async function connect(credentials = {}) {
    if (disposed) throw publicError("The Steam window has closed.");
    if ([...jobs.values()].some(job => !job.controller.signal.aborted && ["preparing", "downloading"].includes(job.record.status))) throw publicError("Finish or cancel active downloads before switching Steam accounts.");
    detach();
    const connectGeneration = accountGeneration;
    let saved;
    if (!credentials.password && credentials.authMethod !== "qr") {
      saved = await options.loadSession?.();
      if (credentials.accountName && String(saved?.accountName || "").toLowerCase() !== String(credentials.accountName).trim().toLowerCase()) saved = null;
    }
    if (disposed || connectGeneration !== accountGeneration) return snapshot();
    const accountName = String(credentials.accountName || saved?.accountName || namedAccount || "").trim();
    if (namedAccount && accountName.toLowerCase() !== namedAccount.toLowerCase()) throw publicError("Choose the matching Steam account before signing in.");
    if (!saved?.refreshToken && (!accountName || !credentials.password && credentials.authMethod !== "qr")) throw publicError("Enter a Steam account name and password, or choose QR sign-in.");
    if (loadedAccount && loadedAccount !== accountName) { state.library = []; state.libraryFetchedAt = null; }
    state.libraryLoading = false;
    remember = credentials.remember !== false;
    state.connection = { status: "connecting", accountName }; state.libraryError = null; emit();
    const Client = options.SteamUser || require("steam-user");
    const current = client = new Client({ dataDirectory: null, autoRelogin: false, enablePicsCache: true, picsCacheAll: false,
      changelistUpdateInterval: 0, renewRefreshTokens: true, promptSteamGuardCode: false });
    // Prefer TLS for both manifest requests and chunks. Legacy CDN-only regions
    // retain the server-provided transport when no TLS server is advertised.
    const getServers = current.getContentServers.bind(current);
    current.getContentServers = async (...args) => {
      const result = await getServers(...args), secure = result.servers.filter(server => ["optional", "mandatory"].includes(server.https_support));
      return { ...result, servers: secure.length ? secure.map(server => ({ ...server, https_support: "mandatory" })) : result.servers };
    };
    ownershipReady = new Promise((resolve, reject) => { resolveOwnership = resolve; rejectOwnership = reject; }); ownershipReady.catch(() => {});
    current.on("error", error => {
      if (client !== current) return;
      cancelAuthentication();
      state.connection = { status: "error", accountName, error: safeError(error, "Steam sign-in or connection failed. Try connecting again.") };
      rejectOwnership?.(error); emit();
    });
    current.on("disconnected", () => { if (client === current && state.connection.status === "connected") { state.connection.status = "disconnected"; emit(); } });
    current.on("steamGuard", (domain, callback, lastCodeWrong) => {
      if (client !== current) return;
      guardCallback = callback;
      state.connection = { status: "guard", accountName, guard: { kind: domain ? "email" : "totp", domain: domain || null, lastCodeWrong: Boolean(lastCodeWrong) } };
      options.onAuthRequired?.(clone(state.connection.guard)); emit();
    });
    let latestRefreshToken = saved?.refreshToken;
    const saveRefreshToken = refreshToken => {
      if (client !== current || !remember || !refreshToken) return;
      Promise.resolve(options.saveSession?.({ accountName, refreshToken })).catch(() => {
        if (client !== current) return;
        state.connection.sessionError = "Steam connected, but the sign-in could not be saved securely. Sign in again after restarting MacLauncher."; emit();
      });
    };
    current.on("refreshToken", refreshToken => { latestRefreshToken = refreshToken; if (state.connection.status === "connected") saveRefreshToken(refreshToken); });
    current.on("ownershipCached", () => { if (client === current) resolveOwnership?.(); });
    current.on("loggedOn", () => { if (client === current) { cancelAuthentication(); state.connection = { status: "connected", accountName }; saveRefreshToken(latestRefreshToken); emit(); loadLibrary().catch(() => {}); } });
    try {
      const logOn = refreshToken => current.logOn({ refreshToken, logonID: crypto.randomInt(1, 0x7fffffff), machineName: "MacLauncher" });
      if (saved?.refreshToken) logOn(saved.refreshToken);
      else {
        // steam-user's password path cancels device/email approval polling and
        // requests a code instead. Use steam-session's public guard API first,
        // then hand its account-bound client token to steam-user for downloads.
        const SteamSession = require("steam-session"), LoginSession = options.LoginSession || SteamSession.LoginSession;
        const login = authSession = new LoginSession(SteamSession.EAuthTokenPlatformType.SteamClient);
        login.loginTimeout = 180000;
        const isCurrent = () => authSession === login && client === current && connectGeneration === accountGeneration;
        const fail = error => {
          if (!isCurrent()) return;
          cancelAuthentication(); rejectOwnership?.(error);
          state.connection = { status: "error", accountName, error: safeError(error, "Steam sign-in failed. Start sign-in again.") }; emit();
        };
        login.on("error", fail);
        login.on("timeout", () => fail(publicError("Steam sign-in timed out. Start sign-in again.")));
        login.on("remoteInteraction", () => { if (isCurrent() && state.connection.guard) { state.connection.guard.remoteInteraction = true; emit(); } });
        login.on("authenticated", () => {
          if (!isCurrent()) return;
          const actualAccount = String(login.accountName || "").trim();
          if (!actualAccount || actualAccount.toLowerCase() !== accountName.toLowerCase()) {
            fail(publicError("Steam authenticated a different account. Select the matching account and start sign-in again.")); return;
          }
          if (typeof login.refreshToken !== "string" || !login.refreshToken) { fail(publicError("Steam did not return a sign-in token. Start sign-in again.")); return; }
          latestRefreshToken = login.refreshToken; state.connection = { status: "connecting", accountName }; emit();
          cancelAuthentication();
          try { logOn(latestRefreshToken); } catch (error) { state.connection = { status: "error", accountName, error: safeError(error, "Steam sign-in could not start.") }; emit(); }
        });
        authDeadline = setTimeout(() => fail(publicError("Steam sign-in timed out. Start sign-in again.")), 180000); authDeadline.unref?.();
        const start = credentials.authMethod === "qr" ? await login.startWithQR() : await login.startWithCredentials({ accountName, password: String(credentials.password) });
        if (isCurrent() && start.actionRequired) {
          const kinds = SteamSession.EAuthSessionGuardType, actions = start.validActions || [], codeKinds = [];
          if (actions.some(action => action.type === kinds.EmailCode)) codeKinds.push("email");
          if (actions.some(action => action.type === kinds.DeviceCode)) codeKinds.push("totp");
          const mobile = actions.some(action => action.type === kinds.DeviceConfirmation), emailApproval = actions.some(action => action.type === kinds.EmailConfirmation);
          const domain = actions.find(action => action.type === kinds.EmailCode || action.type === kinds.EmailConfirmation)?.detail || null;
          const kind = start.qrChallengeUrl ? "qr" : mobile ? "mobile" : emailApproval ? "email-approval" : codeKinds[0];
          if (!kind) throw publicError("Steam requested an unsupported sign-in action. Use the running Steam app session instead.");
          const guard = { kind, domain, codeKinds, lastCodeWrong: false,
            message: kind === "qr" ? "Scan the QR code with the Steam mobile app and approve sign-in." : kind === "mobile" ? "Approve the sign-in prompt in the Steam mobile app." : kind === "email-approval" ? "Approve the Steam sign-in email." : kind === "email" ? "Enter the code sent by Steam email." : "Enter the Steam mobile authenticator code." };
          if (start.qrChallengeUrl) {
            const address = new URL(start.qrChallengeUrl);
            if (address.protocol !== "https:" || address.hostname !== "s.team" || !address.pathname.startsWith("/q/")) throw publicError("Steam returned an invalid QR sign-in address.");
            const qr = require("qrcode-generator")(0, "M"); qr.addData(address.href); qr.make();
            guard.qrChallengeUrl = address.href; guard.qrImageUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }))}`;
          }
          state.connection = { status: "guard", accountName, guard }; options.onAuthRequired?.(clone(guard)); emit();
        }
      }
    } catch (error) { if (client === current && connectGeneration === accountGeneration) { cancelAuthentication(); state.connection = { status: "error", accountName, error: safeError(error, "Steam sign-in could not start.") }; emit(); } }
    return snapshot();
  }
  async function submitAuth({ code } = {}) {
    if (authSession) {
      if (!state.connection.guard?.codeKinds?.length) throw publicError("Approve the Steam sign-in request in the mobile app or email.");
      if (!/^[a-z0-9]{5,8}$/i.test(String(code || "").trim())) throw publicError("Enter the Steam Guard code.");
      const login = authSession, previous = clone(state.connection), generation = accountGeneration;
      state.connection = { status: "connecting", accountName: previous.accountName }; emit();
      try { await login.submitSteamGuardCode(String(code).trim()); }
      catch (error) {
        if (authSession !== login || generation !== accountGeneration) return snapshot();
        if ([65, 88].includes(Number(error.eresult))) { state.connection = previous; state.connection.guard.lastCodeWrong = true; state.connection.guard.error = "Steam Guard code was not accepted. Try another code."; emit(); return snapshot(); }
        cancelAuthentication(); state.connection = { status: "error", accountName: previous.accountName, error: safeError(error, "Steam could not verify this code. Start sign-in again.") }; emit();
      }
      return snapshot();
    }
    if (!guardCallback) throw publicError("Steam has not requested a Guard code.");
    if (!/^[a-z0-9]{5,8}$/i.test(String(code || "").trim())) throw publicError("Enter the Steam Guard code.");
    const callback = guardCallback; guardCallback = null;
    state.connection = { status: "connecting", accountName: state.connection.accountName }; emit(); callback(String(code).trim()); return snapshot();
  }
  async function loadLibrary({ refresh = false } = {}) {
    const current = connected(), generation = accountGeneration;
    if (activeLibrary) return activeLibrary;
    if (!refresh && state.libraryFetchedAt && loadedAccount === state.connection.accountName) return clone(state.library);
    state.libraryLoading = true; state.libraryError = null; emit();
    activeLibrary = (async () => {
      try {
        let ownershipTimer;
        try { await Promise.race([ownershipReady, new Promise((_, reject) => { ownershipTimer = setTimeout(() => reject(publicError("Steam library ownership is taking too long. Refresh to try again.")), 45000); ownershipTimer.unref?.(); })]); }
        finally { clearTimeout(ownershipTimer); }
        if (client !== current || generation !== accountGeneration) throw publicError("The Steam account changed.");
        const owned = current.getOwnedApps(), ownOnly = new Set(current.getOwnedApps({ excludeShared: true }));
        let shared = [];
        try { shared = await (options.loadSharedLibrary || sharedLibrary)(current); }
        catch (error) { if (client === current && generation === accountGeneration) state.libraryError = safeError(error, "The Steam family library could not be loaded. Refresh to try again."); }
        const sharedMap = new Map(shared.map(item => [Number(item.appId || item.appid), item]));
        const ids = [...new Set([...owned, ...sharedMap.keys()])].filter(id => Number.isInteger(id) && id > 0), rows = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
          if (client !== current) throw publicError("The Steam account changed.");
          const { apps } = await current.getProductInfo(ids.slice(offset, offset + 100), [], true);
          for (const appId of ids.slice(offset, offset + 100)) {
            const info = apps?.[appId]?.appinfo, family = sharedMap.get(appId), type = String(info?.common?.type || "game").toLowerCase();
            if (!family && !["game", "application", "demo", "mod", "music", "beta"].includes(type)) continue;
            const icon = info?.common?.icon || family?.iconHash;
            rows.push({ appId, name: info?.common?.name || family?.name || `App ${appId}`, platforms: platforms(info?.common?.oslist), ...steamLibraryArchitectures(info),
              shared: !ownOnly.has(appId), iconUrl: /^[a-f0-9]{40}$/i.test(icon || "") ? `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appId}/${icon}.jpg` : null });
          }
        }
        if (client !== current || generation !== accountGeneration) throw publicError("The Steam account changed.");
        rows.sort((a, b) => a.name.localeCompare(b.name)); state.library = rows; state.libraryFetchedAt = new Date().toISOString(); loadedAccount = state.connection.accountName;
        writeJson(path.join(metadataRoot, "library.json"), { architectureSchema: 1, accountName: state.connection.accountName, fetchedAt: state.libraryFetchedAt, library: rows });
        return clone(rows);
      } catch (error) {
        if (client !== current || generation !== accountGeneration) throw publicError("The Steam account changed.");
        state.libraryError = safeError(error, "The Steam library could not be loaded. Refresh to try again."); throw publicError(state.libraryError);
      } finally { if (generation === accountGeneration) { state.libraryLoading = false; activeLibrary = null; emit(); } }
    })();
    return activeLibrary;
  }
  async function getVersions(value, { refresh = false } = {}) {
    const current = connected(), generation = accountGeneration, appId = numericId(value), file = path.join(metadataRoot, "catalog", `${appId}.json`);
    const cached = versionCache.get(appId) || readJson(file, null);
    if (!refresh && cached?.architectureSchema === 1) return clone(cached);
    const { apps } = await current.getProductInfo([appId], [], true);
    if (client !== current || generation !== accountGeneration) throw publicError("The Steam account changed.");
    if (!apps?.[appId]?.appinfo) throw publicError("Steam did not return versions for this game.");
    const appinfo = apps[appId].appinfo;
    const references = [...new Set(Object.values(appinfo.depots || {}).map(depot => Number(depot?.depotfromapp)).filter(id => id > 0 && id !== appId))];
    if (references.length) {
      const { apps: referencedApps } = await current.getProductInfo(references, [], true);
      if (client !== current || generation !== accountGeneration) throw publicError("The Steam account changed.");
      for (const [depotId, depot] of Object.entries(appinfo.depots || {})) if (depot?.depotfromapp && referencedApps?.[depot.depotfromapp]?.appinfo?.depots?.[depotId])
        appinfo.depots[depotId] = { ...referencedApps[depot.depotfromapp].appinfo.depots[depotId], ...depot };
    }
    const versions = normalizeVersions(appId, appinfo, cached?.history || []);
    // Encrypted branch IDs are kept in the private profile, never sent as keys.
    versionCache.set(appId, versions); writeJson(file, versions); return clone(versions);
  }
  function markImported(id) { const job = state.downloads.find(item => item.id === id); if (job) { job.imported = true; job.importError = null; emit(); } return snapshot(); }
  function download(selection = {}) {
    const current = connected(), appId = numericId(selection.appId), platform = selection.platform || "windows";
    if (!PLATFORMS.includes(platform)) throw publicError("Choose Mac, Windows or Linux.");
    const branch = String(selection.branch || "public"), language = String(selection.language || "english"), architecture = String(selection.architecture || "all");
    if (!/^[a-z0-9_. -]{1,100}$/i.test(branch) || !/^[a-z_ -]{1,60}$/i.test(language) || !["all", ...ARCHITECTURES].includes(architecture)) throw publicError("The Steam version selection is invalid.");
    if (selection.destination && (!path.isAbsolute(selection.destination) || /[\x00-\x1f]/.test(selection.destination))) throw publicError("Choose an absolute download folder.");
    const record = { id: crypto.randomUUID(), appId, name: String(selection.name || state.library.find(row => row.appId === appId)?.name || `App ${appId}`),
      platform, branch, language, architecture, autoImport: selection.autoImport !== false, imported: false, status: "queued", downloaded: 0, total: null,
      detail: "Preparing download", path: null, createdAt: new Date().toISOString() };
    const controller = new AbortController(), signal = controller.signal;
    jobs.set(record.id, { record, controller }); state.downloads.unshift(record); emit();
    const progress = detail => { record.detail = detail; emit(); }; let stage, terminalStatus;
    const promise = (async () => {
      try {
        record.status = "preparing"; emit();
        const versions = await abortable(getVersions(appId), signal), branchInfo = versions.branches.find(item => item.id === branch);
        if (!branchInfo) throw publicError("The selected Steam branch is unavailable. Refresh versions and choose again.");
        const explicit = Array.isArray(selection.depots) && selection.depots.length ? selection.depots : null;
        if (!explicit && architecture !== "all" && !versions.architectures?.[platform]?.includes(architecture)) throw publicError("Steam does not advertise this architecture for the selected platform. Choose a listed architecture or select depots explicitly.");
        let choices = explicit ? explicit.map(item => {
          const id = numericId(item.depotId, "Steam depot"), depot = versions.depots.find(row => row.id === id) ||
            (item.manifestId ? { id, name: `Depot ${id}`, manifests: {}, platforms: [], architectures: [], languages: [] } : null);
          if (!depot) throw publicError("Enter a manifest ID for the additional Steam depot.");
          return { depot, manifestId: item.manifestId ? manifestId(item.manifestId) : depot.manifests[branch]?.id, currentManifest: !item.manifestId };
        }) : versions.depots.filter(depot => (!depot.platforms.length || depot.platforms.includes(platform)) &&
          matchesSteamArchitecture(depot, architecture) &&
          (!depot.languages.length || depot.languages.includes(language)) && (!depot.requiresAppId || current.ownsApp(depot.requiresAppId)))
          .filter(depot => depot.manifests[branch] || depot.encryptedBranches.includes(branch)).map(depot => ({ depot, manifestId: depot.manifests[branch]?.id, currentManifest: true }));
        if (!choices.length) throw publicError("Steam has no matching depots for this platform, language and architecture. Choose another version or select depots explicitly.");
        if (choices.some(item => !item.manifestId)) {
          if (!selection.branchPassword) throw publicError("This Steam branch requires a password.");
          const { keys } = await abortable(current.getAppBetaDecryptionKeys(appId, String(selection.branchPassword)), signal);
          const key = keys[branch]; if (!key) throw publicError("Steam did not unlock the selected branch.");
          const { apps } = await abortable(current.getProductInfo([appId], [], true), signal);
          for (const item of choices) if (!item.manifestId) {
            const encrypted = apps?.[appId]?.appinfo?.depots?.[item.depot.id]?.encryptedmanifests?.[branch]?.encrypted_gid_2;
            if (!encrypted) throw publicError("Steam did not return the selected branch manifest.");
            const bytes = Buffer.from(encrypted, "hex"), decipher = crypto.createDecipheriv("aes-256-ecb", key, null); decipher.setAutoPadding(false);
            item.manifestId = manifestId(Buffer.concat([decipher.update(bytes), decipher.final()]).readBigUInt64LE(0).toString());
          }
        }
        const selectedDepots = choices.map(item => ({ depotId: item.depot.id, manifestId: item.manifestId }));
        const duplicateRequest = { userDataDir: options.userDataDir, store: "steam", appId, platform, depots: selectedDepots, destination: selection.destination, confirmDuplicate: options.confirmDuplicate, signal };
        const { checkExistingDownload, createDownloadIdentity } = require("./external-download-duplicates");
        record.downloadIdentity = createDownloadIdentity(duplicateRequest);
        const existing = await abortable(checkExistingDownload(duplicateRequest), signal);
        if (existing) return await reuseCompletedDownload(record, existing, { signal, onChange: emit, onDownloaded: options.onDownloaded });
        const manifests = [];
        for (const choice of choices) {
          signal.throwIfAborted(); progress(`Reading ${choice.depot.name}`);
          const contentAppId = choice.depot.depotFromAppId || appId;
          const { manifest } = await abortable(current.getManifest(contentAppId, choice.depot.id, choice.manifestId, branch, selection.branchPassword || undefined), signal);
          manifests.push({ ...choice, contentAppId, manifest });
        }
        const identity = describeSteamSelection(branch, branchInfo, choices), suffix = identity.manifestSetId;
        record.buildId = identity.buildId; record.versionName = identity.versionName; record.version = identity.versionName;
        const label = `${branch.replace(/[^a-z0-9_.-]+/gi, "-")}-${identity.buildId || "manifest"}-${suffix}`;
        const parent = selection.destination ? path.resolve(selection.destination) : path.join(defaultDirectory, String(appId), platform);
        fs.mkdirSync(parent, { recursive: true }); const realParent = fs.realpathSync(parent);
        stage = fs.mkdtempSync(path.join(realParent, ".steam-download-"));
        const finalPrefix = path.join(realParent, selection.destination ? `${record.name.replace(/[^a-z0-9_. -]+/gi, "").slice(0, 70) || appId}-${platform}-${label}-` : `${label}-`);
        const finalPath = `${finalPrefix}${record.id}`;
        if (fs.existsSync(finalPath)) throw publicError("The selected download folder already contains this installation.");
        record.path = finalPath;
        const contents = new Map();
        for (const item of manifests) for (const file of item.manifest.files || []) {
          const output = containedFile(stage, String(file.filename).replace(/\/$/, "")), flags = Number(file.flags);
          if (flags & 64) contents.set(output, { kind: "directory", output });
          else if (flags & 512) {
            const target = String(file.linktarget || "").replace(/\\/g, "/"), resolved = path.resolve(path.dirname(output), target);
            if (!target || path.isAbsolute(target) || /^[a-z]:/i.test(target) || !(resolved === stage || resolved.startsWith(`${stage}${path.sep}`))) throw publicError("Steam supplied an unsafe symbolic link.");
            contents.set(output, { kind: "symlink", output, target });
          } else contents.set(output, { kind: "file", item, file, output });
        }
        const symlinks = [...contents.values()].filter(item => item.kind === "symlink"), dirs = [...contents.values()].filter(item => item.kind === "directory").map(item => item.output);
        const allFiles = [...contents.values()].filter(item => item.kind === "file");
        record.total = allFiles.reduce((sum, item) => sum + (Number(item.file.size) || 0), 0);
        for (const directory of dirs) { checkParent(stage, directory); fs.mkdirSync(directory, { recursive: true }); }
        const serverLists = new Map();
        for (const contentAppId of new Set(manifests.map(item => item.contentAppId))) {
          const { servers } = await abortable(current.getContentServers(contentAppId), signal);
          if (!servers?.length) throw publicError("No Steam content server is available.");
          serverLists.set(contentAppId, servers);
        }
        record.status = "downloading"; let lastEmit = 0;
        for (const { item, file, output } of allFiles) {
          signal.throwIfAborted(); checkParent(stage, output); progress(file.filename);
          await transferFile(current, item.contentAppId, item.depot.id, file, output, { signal, servers: serverLists.get(item.contentAppId),
            onBytes: count => { record.downloaded += count; if (Date.now() - lastEmit > 150) { lastEmit = Date.now(); emit(); } } });
        }
        for (const { output, target } of symlinks) { signal.throwIfAborted(); checkParent(stage, output); if (fs.existsSync(output)) throw publicError("Steam supplied conflicting symbolic links."); fs.symlinkSync(target, output); }
        signal.throwIfAborted();
        const metadata = { schema: 1, appId, name: record.name, platform, branch, buildId: identity.buildId, versionName: identity.versionName, version: identity.versionName, importPath: finalPath, path: finalPath, createdAt: record.createdAt, complete: true,
          depots: selectedDepots, architecture, downloadIdentity: record.downloadIdentity };
        writeJson(path.join(stage, ".maclauncher-steam.json"), metadata);
        // A full random installation ID prevents collisions with any prior files.
        // A private sibling stage becomes visible only after every file verifies.
        fs.renameSync(stage, finalPath); stage = null;
        const installations = readJson(path.join(root, "installations.json"), []);
        writeJson(path.join(root, "installations.json"), [...installations.filter(item => (typeof item === "string" ? item : item.path) !== finalPath), metadata]);
        record.status = "completed"; record.downloaded = record.total; record.detail = "Download complete"; record.completedAt = new Date().toISOString(); emit();
        if (record.autoImport && options.onDownloaded) {
          try { await options.onDownloaded(clone(record)); record.imported = true; }
          catch { record.importError = "The download is complete, but no supported game was imported. Import the folder manually to choose files."; }
        }
        const history = versions.history || [];
        for (const item of metadata.depots) if (!history.some(row => row.depotId === item.depotId && row.manifestId === item.manifestId)) history.push({ ...item, branch, observedAt: record.completedAt });
        versions.history = history.slice(-500); versionCache.set(appId, versions);
        try { writeJson(path.join(metadataRoot, "catalog", `${appId}.json`), versions); } catch {}
      } catch (error) {
        if (signal.aborted || error?.code === "ABORT_ERR" || error?.name === "AbortError") { terminalStatus = "cancelled"; record.detail = "Download cancelled"; }
        else { terminalStatus = "error"; record.error = safeError(error, "Steam could not download this version. Check account access, the selected depots and manifest IDs, then try again."); record.detail = record.error; }
      } finally { if (stage) await fs.promises.rm(stage, { recursive: true, force: true }); if (terminalStatus) record.status = terminalStatus; jobs.delete(record.id); emit(); }
      return clone(record);
    })();
    jobs.get(record.id).promise = promise;
    return clone(record);
  }
  function cancel(id) { const job = jobs.get(id); if (job) job.controller.abort(); return snapshot(); }
  async function dispose() { disposed = true; for (const job of jobs.values()) job.controller.abort(); detach(); await Promise.allSettled([...jobs.values()].map(job => job.promise)); }
  return { snapshot, connect, submitAuth, disconnect, loadLibrary, getVersions, download, cancel, markImported, dispose };
}

module.exports = { createSteamDownloads, normalizeVersions, describeSteamSelection, localAccount, sharedLibrary, protoField, protoFields, containedFile, transferFile, HISTORY_NOTE };
