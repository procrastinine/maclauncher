const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { readMachOArchitectures, hashFile } = require("../../runtime/local-native");
const { inspectMachOExports } = require("../../runtime/macho-exports");

const run = promisify(execFile);
const PIN = Object.freeze({ sdkVersion: "1.63", version: "sdk-1.63-c3a1cd191b1e-7824c030a762",
  sha256: "c3a1cd191b1e4a1a2f1b07e17a74813d61e296ae6e4d819f705081450928ecd9", bytes: 1709968,
  filename: "libsdkencryptedappticket.dylib", sourceRelativePath: "public/steam/lib/osx/libsdkencryptedappticket.dylib",
  architectures: Object.freeze(["arm64", "x86_64"]), minimumMacOS: Object.freeze({ arm64: "11.0", x86_64: "10.15" }),
  symbols: Object.freeze(["SteamEncryptedAppTicket_BDecryptTicket", "SteamEncryptedAppTicket_BIsTicketForApp", "SteamEncryptedAppTicket_GetTicketAppID",
    "SteamEncryptedAppTicket_GetTicketIssueTime", "SteamEncryptedAppTicket_GetTicketSteamID"]),
  api: Object.freeze({ filename: "libsteam_api.dylib", sourceRelativePath: "redistributable_bin/osx/libsteam_api.dylib",
    sha256: "7824c030a7626ac1de9f1c6e03d45276721aa88ac419954b235cccf4546b15b3", bytes: 427216,
    symbols: Object.freeze(["SteamAPI_GetHSteamUser", "SteamInternal_ContextInit", "SteamInternal_FindOrCreateUserInterface", "SteamAPI_IsSteamRunning",
      "SteamAPI_RestartAppIfNecessary", "SteamAPI_RegisterCallback", "SteamAPI_UnregisterCallback", "SteamInternal_SteamAPI_Init",
      "SteamAPI_RegisterCallResult", "SteamAPI_UnregisterCallResult", "SteamAPI_RunCallbacks"]) }) });
const identities = new Map();

function error(message, code = "GREENWORKS_TICKET_INVALID") { return Object.assign(new Error(message), { code }); }
function realDirectory(directory) {
  if (!path.isAbsolute(directory || "")) throw error("Steamworks SDK import requires an absolute directory.");
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error("Steamworks SDK import requires a regular directory.");
  return fs.realpathSync(directory);
}
function managedDirectory(userDataDir) { return path.join(userDataDir, "runtimes", "greenworks-sdk", PIN.version); }
function ownedRoot(userDataDir, create = false) {
  const userRoot = realDirectory(userDataDir);
  let directory = userRoot;
  for (const part of ["runtimes", "greenworks-sdk"]) {
    directory = path.join(directory, part);
    if (create && !fs.existsSync(directory)) fs.mkdirSync(directory);
    realDirectory(directory);
  }
  return directory;
}
function inspectTicket(file, pin = PIN) {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== BigInt(pin.bytes)) throw error("The native Steamworks SDK library does not match a listed version.");
  const identity = JSON.stringify([fs.realpathSync(file), String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]);
  if (!identities.has(identity)) {
    if (hashFile(file) !== pin.sha256) throw error("The native library checksum does not match Steamworks SDK 1.63.");
    const architectures = readMachOArchitectures(file, { allowLibrary: true });
    if (architectures.length !== pin.architectures.length || pin.architectures.some(arch => !architectures.includes(arch))) throw error("The native encrypted-ticket library lacks its listed CPU slices.");
    identities.set(identity, true); if (identities.size > 64) identities.delete(identities.keys().next().value);
  }
  return { version: pin.version, sdkVersion: pin.sdkVersion, libraryPath: file, sha256: pin.sha256, architectures: [...pin.architectures] };
}
function resolveManagedTicket(userDataDir, pin = PIN) {
  if (!path.isAbsolute(userDataDir || "")) return null;
  try {
    const directory = path.join(ownedRoot(userDataDir), pin.version);
    realDirectory(directory);
    const receiptPath = path.join(directory, "receipt.json"), receiptStat = fs.lstatSync(receiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 32768) return null;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    if (receipt.version !== pin.version || receipt.sdkVersion !== pin.sdkVersion || receipt.sha256 !== pin.sha256 ||
        receipt.apiSha256 != null && receipt.apiSha256 !== pin.api.sha256 || receipt.source !== "explicit-local-sdk-import") return null;
    let api, nativeApiReason;
    if (receipt.apiSha256) {
      try { api = inspectTicket(path.join(directory, pin.api.filename), { ...pin, ...pin.api }); }
      catch (failure) { nativeApiReason = failure.message; }
    }
    const expectedFiles = [pin.filename, "receipt.json", ...(receipt.apiSha256 ? [pin.api.filename] : [])].sort();
    if (fs.readdirSync(directory).some(name => name !== ".DS_Store" && !expectedFiles.includes(name))) return null;
    return { ...inspectTicket(path.join(directory, pin.filename), pin), source: receipt.source, installDir: directory,
      ...(api ? { apiLibraryPath: api.libraryPath, apiSha256: api.sha256 } : {}), ...(nativeApiReason ? { nativeApiReason } : {}) };
  } catch { return null; }
}
function resolveQualifiedTicket({ userDataDir, gameRoots = [], bridgeDir, pin = PIN }) {
  const candidates = new Set(), apiCandidates = new Set();
  for (const root of gameRoots.filter(root => path.isAbsolute(root || ""))) {
    for (const relative of [pin.filename, path.join("lib", pin.filename)]) candidates.add(path.join(root, relative));
    for (const relative of [pin.api.filename, path.join("lib", pin.api.filename)]) apiCandidates.add(path.join(root, relative));
  }
  if (bridgeDir) candidates.add(path.join(bridgeDir, "lib", pin.filename));
  if (bridgeDir) apiCandidates.add(path.join(bridgeDir, "lib", pin.api.filename));
  let ticket;
  for (const file of candidates) {
    try { ticket = { ...inspectTicket(file, pin), source: "native-game-library" }; break; } catch {}
  }
  const managed = resolveManagedTicket(userDataDir, pin);
  ticket ||= managed;
  if (!ticket) return null;
  for (const file of apiCandidates) {
    try { const api = inspectTicket(file, { ...pin, ...pin.api });
      return { ...ticket, apiLibraryPath: api.libraryPath, apiSha256: api.sha256 }; } catch {}
  }
  return managed?.apiLibraryPath ? { ...ticket, apiLibraryPath: managed.apiLibraryPath, apiSha256: managed.apiSha256,
    installDir: managed.installDir } : ticket;
}

async function importSdk({ userDataDir, runtimeRoot, runtimePath, version, dependencies = {} }, pin = PIN) {
  if (version && version !== pin.version) throw error("Choose the explicitly listed native SDK 1.63 input.");
  const source = realDirectory(runtimeRoot || runtimePath);
  const inputFor = record => {
    for (const file of [path.join(source, record.sourceRelativePath), path.join(source, record.filename)]) {
      try { fs.lstatSync(file); return file; } catch (failure) { if (failure.code !== "ENOENT") throw failure; }
    }
    return null;
  };
  const input = inputFor(pin);
  if (!input) throw error(`The selected directory lacks ${pin.filename} from SDK ${pin.sdkVersion}.`);
  const sourceRelative = path.relative(source, fs.realpathSync(input));
  if (!sourceRelative || sourceRelative === ".." || sourceRelative.startsWith(".." + path.sep) || path.isAbsolute(sourceRelative)) throw error("The selected SDK references a native ticket library outside that SDK.");
  const apiInput = inputFor(pin.api), apiRelative = apiInput && path.relative(source, fs.realpathSync(apiInput));
  if (apiInput && (!apiRelative || apiRelative === ".." || apiRelative.startsWith(".." + path.sep) || path.isAbsolute(apiRelative))) throw error("The selected SDK references its native Steam API library outside that SDK.");
  const sourceBefore = inspectTicket(input, pin), apiPin = { ...pin, ...pin.api };
  const apiBefore = apiInput && inspectTicket(apiInput, apiPin);
  const inputs = [[input, pin], ...(apiInput ? [[apiInput, apiPin]] : [])];
  const exportsFor = dependencies.inspectExports || inspectMachOExports;
  for (const [file, record] of inputs) for (const arch of pin.architectures) {
    const symbols = await exportsFor(file, { arch });
    if (record.symbols.some(symbol => !symbols.includes(symbol))) throw error(`The SDK ${pin.sdkVersion} native library lacks required ${arch} exports.`);
  }
  const verifySignature = dependencies.verifySignature || (file => run("/usr/bin/codesign", ["--verify", "--strict", file], { timeout: 30000, maxBuffer: 1024 * 1024 }));
  for (const [file, record] of inputs) { await verifySignature(file); inspectTicket(file, record); }
  for (const [file, record] of inputs) inspectTicket(file, record);
  if (!path.isAbsolute(userDataDir || "")) throw error("Steamworks SDK import requires a launcher data directory.");
  fs.mkdirSync(userDataDir, { recursive: true });
  const root = ownedRoot(userDataDir, true);
  const existing = resolveManagedTicket(userDataDir, pin);
  if (existing && (!apiInput || existing.apiLibraryPath)) return existing;
  const directory = path.join(root, pin.version), work = fs.mkdtempSync(path.join(root, ".import-")), staging = path.join(work, "candidate");
  fs.mkdirSync(staging);
  try {
    for (const [file, record] of inputs) {
      fs.copyFileSync(file, path.join(staging, record.filename));
      inspectTicket(file, record); inspectTicket(path.join(staging, record.filename), record);
    }
    const receipt = { version: pin.version, sdkVersion: pin.sdkVersion, sha256: pin.sha256,
      source: "explicit-local-sdk-import", sourceRelativePath: pin.sourceRelativePath, apiSha256: apiBefore?.sha256 || null,
      architectures: pin.architectures, minimumMacOS: pin.minimumMacOS, importedAt: Date.now() };
    fs.writeFileSync(path.join(staging, "receipt.json"), JSON.stringify(receipt, null, 2), { flag: "wx" });
    for (const [, record] of inputs) await verifySignature(path.join(staging, record.filename));
    for (const [file, record] of inputs) inspectTicket(file, record);
    const backup = path.join(work, "previous");
    let previous = false;
    if (fs.existsSync(directory)) { realDirectory(directory); fs.renameSync(directory, backup); previous = true; }
    try { fs.renameSync(staging, directory); }
    catch (failure) { if (previous) fs.renameSync(backup, directory); throw failure; }
    try {
      const result = resolveManagedTicket(userDataDir, pin);
      if (!result || sourceBefore.sha256 !== inspectTicket(input, pin).sha256 ||
          apiBefore && apiBefore.sha256 !== inspectTicket(apiInput, apiPin).sha256) throw error("The native SDK libraries changed during import.");
      return result;
    } catch (failure) {
      fs.rmSync(directory, { recursive: true, force: true });
      if (previous) fs.renameSync(backup, directory);
      throw failure;
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}

module.exports = { PIN, managedDirectory, inspectTicket, resolveManagedTicket, resolveQualifiedTicket, importSdk };
