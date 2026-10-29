const fs = require("node:fs"), path = require("node:path");
const {promisify} = require("node:util"), run = promisify(require("node:child_process").execFile);
const Bundled = require("./bundled-native"), Native = require("./local-native");
const caches = new WeakMap();

// Code-signature policy shared with native helper attachment. Missing facts
// remain unknown; they are not evidence that an executable blocks injection.
function parseSignature(output) {
  output = String(output || "");
  const match = output.match(/flags=0x([a-f0-9]+)/i), flags = match ? parseInt(match[1], 16) : null;
  const entitlement = name => new RegExp(`<key>\\s*${name.replace(/\./g, "\\.")}\\s*</key>\\s*<true\\s*/>`, "i").test(output);
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim();
  return {flags, unsigned: /code object is not signed at all/i.test(output), teamIdentifier: team && team !== "not set" ? team : null,
    allowDyld: entitlement("com.apple.security.cs.allow-dyld-environment-variables"),
    disableLibraryValidation: entitlement("com.apple.security.cs.disable-library-validation")};
}
function evaluate(target, libraries = []) {
  if (target.unsigned) return {available: true};
  if (target.flags === null) return {available: null};
  if (target.flags & 0x800) return {available: false, reason: "The executable's code-signature policy blocks DYLD graphics attachment."};
  if (target.flags & 0x10000 && !target.allowDyld)
    return {available: false, reason: "The executable's hardened runtime does not allow DYLD graphics attachment."};
  if ((target.flags & (0x2000 | 0x10000)) && !target.disableLibraryValidation) {
    if (!libraries.length || libraries.some(item => item.flags === null && !item.unsigned)) return {available: null};
    if (!target.teamIdentifier || libraries.some(item => !item.teamIdentifier || item.teamIdentifier !== target.teamIdentifier))
      return {available: false, reason: "The executable's library-validation policy does not allow the selected graphics library."};
  }
  return {available: true};
}
async function inspect(file, {execute = run, signal} = {}) {
  signal?.throwIfAborted();
  let canonical, identity;
  try {
    canonical = fs.realpathSync(file);identity = Bundled.fileIdentity(canonical);
    Native.readMachOArchitectures(canonical, {allowLibrary: true});
  } catch { return {flags: null}; }
  let cache = caches.get(execute);if (!cache) {cache = new Map();caches.set(execute, cache);}
  const previous = cache.get(canonical);
  if (previous?.identity === identity && (previous.settled || previous.signal === signal)) {const facts = await previous.promise;signal?.throwIfAborted();return facts;}
  const promise = (async () => {
    const env = {...process.env};
    for (const key of Object.keys(env)) if (/^(?:DYLD_|RESHADE_)/.test(key)) delete env[key];
    let output;
    try {
      const result = await execute("/usr/bin/codesign", ["--display", "--verbose=4", "--entitlements", ":-", canonical],
        {env, signal, timeout: 10000, maxBuffer: 1024 * 1024});
      output = String(result.stdout || "") + "\n" + String(result.stderr || "");
    } catch (error) {
      signal?.throwIfAborted();
      output = String(error.stdout || "") + "\n" + String(error.stderr || "");
    }
    if (Bundled.fileIdentity(canonical) !== identity) {if (cache.get(canonical)?.promise === promise) cache.delete(canonical);return {flags: null};}
    const facts = parseSignature(output), current = cache.get(canonical);
    if (current?.promise === promise) {if (facts.flags === null && !facts.unsigned) cache.delete(canonical);else current.settled = true;}
    return facts;
  })();
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(canonical, {identity, promise, signal, settled: false});
  try { const facts = await promise;signal?.throwIfAborted();return facts; } catch (error) {if (cache.get(canonical)?.promise === promise) cache.delete(canonical);signal?.throwIfAborted();return {flags: null};}
}
async function preflight(executable, libraries, options = {}) {
  options.signal?.throwIfAborted();
  // A shell transport can explicitly defer inspection until its real target
  // is known. No executable/runtime name establishes attachability.
  if (typeof executable !== "string" || !path.isAbsolute(executable) || executable.includes("\0")) return {available: null};
  const target = await inspect(executable, options), direct = evaluate(target);
  if (direct.available === false || target.flags === null || target.unsigned || !(target.flags & (0x2000 | 0x10000)) || target.disableLibraryValidation) return direct;
  const facts = await Promise.all([...new Set(libraries)].map(file => inspect(file, options)));
  return evaluate(target, facts);
}
function withoutGraphics(environment, graphics, original = {}) {
  const result = {...environment}, libraries = new Set(String(graphics?.DYLD_INSERT_LIBRARIES || "").split(path.delimiter).filter(Boolean));
  for (const key of ["DYLD_INSERT_LIBRARIES", "STEAM_DYLD_INSERT_LIBRARIES"]) {
    const retained = String(result[key] || "").split(path.delimiter).filter(file => file && !libraries.has(file));
    if (retained.length) result[key] = retained.join(path.delimiter);else delete result[key];
  }
  for (const key of Object.keys(graphics || {})) if (key.startsWith("RESHADE_") || ["FSR4_ROOT", "FSR4_BUILD_DIR"].includes(key)) {
    if (Object.hasOwn(original, key) && original[key] !== graphics[key]) result[key] = original[key];else delete result[key];
  }
  return result;
}
module.exports = {parseSignature, evaluate, inspect, preflight, withoutGraphics};
