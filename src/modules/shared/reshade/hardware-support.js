const fs = require("node:fs"), path = require("node:path");
const {execFile} = require("node:child_process"), {promisify} = require("node:util");
const Native = require("../runtime/bundled-native");
const execute = promisify(execFile), queries = new Map();
const OPERATIONS = Object.freeze(["spatial", "temporal", "denoised", "interpolation"]);
const MINIMUM_MACOS = Object.freeze({spatial:"13.0",temporal:"13.0",denoised:"26.0",interpolation:"26.0"});
const clean = value => typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256) : undefined;
const unknown = (reason,macOSVersion) => ({state: "unknown", ...(reason ? {reason} : {}),...(macOSVersion?{macOSVersion}:{})});
function systemVersion(options={}){
  if(options.macOSVersion)return options.macOSVersion;
  if((options.platform||process.platform)!=="darwin")return undefined;
  try{return Native.systemVersionSync();}catch{return undefined;}
}
function operation(value) {
  if (!value || typeof value !== "object" || typeof value.supported !== "boolean" || typeof value.metal4Supported !== "boolean" ||
      typeof value.minimumMacOS !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(value.minimumMacOS)) throw new Error("Invalid MetalFX device capabilities.");
  const result = {supported: value.supported, metal4Supported: value.metal4Supported, minimumMacOS: value.minimumMacOS};
  for (const key of ["reason", "metal4Reason", "scaleReason"]) if (clean(value[key])) result[key] = clean(value[key]);
  if (value.minScale != null || value.maxScale != null) {
    if (![value.minScale, value.maxScale].every(n => typeof n === "number" && Number.isFinite(n) && n > 0) || value.maxScale < value.minScale)
      throw new Error("Invalid MetalFX device scale interval.");
    result.minScale = value.minScale;result.maxScale = value.maxScale;
  }
  return result;
}
function identity(value) {
  if (value?.name === null && value.registryID === null) return {name: null, registryID: null};
  if (!clean(value?.name) || typeof value.registryID !== "string" || !/^\d{1,20}$/.test(value.registryID)) throw new Error("Invalid Metal device identity.");
  return {name: clean(value.name), registryID: value.registryID};
}
function validate(value) {
  if (value?.schema !== 1 || !Array.isArray(value.devices) || value.devices.length > 64) throw new Error("Invalid graphics hardware response.");
  const device = identity(value.device), seen = new Set();
  const devices = value.devices.map(row => {
    const id = identity(row);
    if (!id.registryID || seen.has(id.registryID) || typeof row.isDefault !== "boolean") throw new Error("Invalid Metal device inventory.");
    seen.add(id.registryID);
    return {...id, isDefault: row.isDefault, metalfx: Object.fromEntries(OPERATIONS.map(key => [key, operation(row.metalfx?.[key])]))};
  });
  const defaults = devices.filter(row => row.isDefault);
  if (defaults.length > 1 || defaults.length && defaults[0].registryID !== device.registryID) throw new Error("Invalid default Metal device.");
  const metalfx = Object.fromEntries(OPERATIONS.map(key => [key, operation(value.metalfx?.[key])]));
  if (defaults.length && JSON.stringify(defaults[0].metalfx) !== JSON.stringify(metalfx)) throw new Error("Conflicting MetalFX device capabilities.");
  return {state: "ready", schema: 1, device, devices, metalfx};
}
function queryIdentity(root, {platform = process.platform} = {}) {
  if (platform !== "darwin") return null;
  try {
    const record = require("./runtime-record").read(root);
    if (record.features?.graphics?.hardwareQueryAPI !== 1) return null;
    const file = path.join(fs.realpathSync(root), "maclauncher-graphics-hardware"), stat = fs.statSync(file);
    if (!stat.isFile() || !(stat.mode & 0o111)) return null;
    return {file, key: JSON.stringify([file, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs])};
  } catch { return null; }
}
function snapshot(root, options = {}) {
  const selected = queryIdentity(root, options);
  return selected ? queries.get(selected.key)?.value || unknown(undefined,systemVersion(options)) : unknown("GPU capabilities are not reported by the selected graphics processor.",systemVersion(options));
}
async function inspect(root, options = {}) {
  const selected = queryIdentity(root, options);
  if (!selected) return snapshot(root, options);
  const now = Date.now(), previous = queries.get(selected.key);
  if (previous?.pending) return previous.pending;
  if (previous && !options.refresh && now - previous.updatedAt < (previous.value.state === "ready" ? 60000 : 5000)) return previous.value;
  const record = {value: previous?.value || unknown(undefined,systemVersion(options)), updatedAt: now};
  queries.set(selected.key, record);
  if (queries.size > 16) for (const [key, row] of queries) if (!row.pending && key !== selected.key) {queries.delete(key);break;}
  record.pending = Promise.resolve().then(async () => {
    try {
      const env = {...process.env};
      for (const key of Object.keys(env)) if (/^(?:DYLD_|RESHADE_|MTL_CAPTURE_)/.test(key)) delete env[key];
      const {stdout} = await (options.execute || execute)(selected.file, [], {timeout: 3000, maxBuffer: 128 << 10, encoding: "utf8", env});
      record.value = {...validate(JSON.parse(stdout)), macOSVersion: systemVersion(options)};
    } catch { record.value = unknown("GPU capabilities could not be read.",systemVersion(options)); }
    finally {record.updatedAt = Date.now();record.pending = null;}
    return record.value;
  });
  return record.pending;
}
function operationReason(hardware, name, {macOSVersion, deviceRegistryID} = {}) {
  if (!OPERATIONS.includes(name)) return null;
  // SDK API floors are known independently of a device query. A missing or
  // failed helper must not hide them or invent a negative GPU capability.
  const system = macOSVersion || hardware?.macOSVersion;
  if(system&&!Native.versionAtLeast(system,MINIMUM_MACOS[name]))return `Requires macOS ${MINIMUM_MACOS[name]} or later.`;
  if (hardware?.state !== "ready") return null;
  const chosen = deviceRegistryID && hardware.devices.find(row => row.registryID === String(deviceRegistryID));
  const candidates = chosen ? [chosen] : hardware.devices;
  if (!candidates.length) return "No Metal GPU is available.";
  if (candidates.some(row => row.metalfx[name].supported)) return null;
  const floor = hardware.metalfx[name].minimumMacOS;
  if (system && !Native.versionAtLeast(system, floor)) return `Requires macOS ${floor} or later.`;
  // A failed device query is unknown, rather than a negative device capability.
  if (candidates.some(row => row.metalfx[name].reason)) return null;
  return chosen ? `Not supported by ${chosen.name}.` : "Not supported by the detected GPUs.";
}
module.exports = {inspect, snapshot, operationReason, validate, OPERATIONS};
