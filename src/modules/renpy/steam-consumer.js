const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { readGameConfigurationSources } = require("./script-config");
const { sourceAssignments } = require("./save-location");
const { readGameAppId, positiveAppId } = require("../shared/runtime/steamworks/app-id");
const ProjectOverlay = require("./runtime/project-overlay");

const KEYS = ["steam_appid", "enable_steam"];
const BOOTSTRAP = "00_maclauncher_steam.rpy";
const RECEIPT = ".maclauncher-renpy-steam.json";
const HEADER = "# MacLauncher owned per-game Steam path mapping v1\n";
const abiCache = new Map();
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

// Retain syntax/line positions, while dialogue, comments and documentation
// cannot become evidence of a Python API call.
function maskStrings(text) {
  let result = "", quote = null;
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (quote) {
      if (text.startsWith(quote, index)) { result += " ".repeat(quote.length); index += quote.length; quote = null; }
      else if (character === "\\") { result += " "; index++; if (index < text.length) result += text[index++] === "\n" ? "\n" : " "; }
      else { result += character === "\n" ? "\n" : " "; index++; }
    } else if (character === "#") {
      while (index < text.length && text[index] !== "\n") { result += " "; index++; }
    } else if (character === '"' || character === "'") {
      quote = text.startsWith(character.repeat(3), index) ? character.repeat(3) : character;
      result += " ".repeat(quote.length); index += quote.length;
    } else { result += character; index++; }
  }
  return result;
}

function gameSteamCalls(text, { python = false } = {}) {
  text = text.replace(/\r\n?/g, "\n");
  const calls = [], blocks = [], bodies = [];
  const pattern = /(?<![A-Za-z0-9_.])((?:(?:renpy\.)?store\.)?achievement\.(?:steam|steamapi)|_renpysteam|steamapi)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  for (const [index, line] of maskStrings(text).split(/\r?\n/).entries()) {
    bodies.push(" ".repeat(line.length));
    if (!line.trim()) continue;
    const indentation = line.match(/^\s*/)[0].replaceAll("\t", "    ").length;
    while (blocks.length && indentation <= blocks.at(-1)) blocks.pop();
    if (python || blocks.length || /^\s*\$/.test(line)) {
      bodies[bodies.length - 1] = line;
      for (const match of line.matchAll(pattern)) calls.push({ namespace: match[1], method: match[2], line: index + 1, requiredInit: true });
    }
    if (/^\s*(?:(?:init(?:\s+-?\d+)?\s+)?python(?:\s+early|\s+hide|\s+in\s+[A-Za-z_][\w.]*)?)\s*:\s*$/.test(line)) blocks.push(indentation);
  }
  const body = bodies.join("\n");
  const register = /(?<![A-Za-z0-9_.])((?:(?:renpy\.)?store\.)?achievement)\s*\.\s*register\s*\(/g;
  for (const match of body.matchAll(register)) {
    // An explicit top-level steam= argument names a Steam backend. Ordinary
    // achievement registration remains a generic, optional Ren'Py facility.
    const start = match.index + match[0].length;
    let depth = 1, argumentsMask = "", end = start;
    for (; end < Math.min(body.length, start + 64 * 1024) && depth; end++) {
      const character = body[end];
      if ("([{".includes(character)) { depth++; argumentsMask += " "; }
      else if (")]}".includes(character)) { depth--; argumentsMask += " "; }
      else argumentsMask += depth === 1 ? character : " ";
    }
    if (depth) continue;
    const steam = /\bsteam\s*=(?!=)/.exec(argumentsMask);
    if (!steam) continue;
    const original = text.slice(start + steam.index + steam[0].length, end - 1).trimStart();
    if (/^(?:None|False)\b|^(?:u|r)?(?:""|'')\s*(?:,|$)/.test(original)) continue;
    calls.push({ namespace: match[1], method: "register", line: body.slice(0, match.index).split("\n").length,
      requiredInit: false, intent: "steam-achievement-registration" });
  }
  return calls;
}

/** Original game code only. Shipping Ren'Py's common Steam provider is optional. */
function inspectGameSteamConsumer({ gameRoot, gameDir = path.join(gameRoot, "game") }) {
  const inspection = readGameConfigurationSources([gameDir], { keys: KEYS, includePythonSources: true });
  const calls = [], assignments = [];
  for (const item of inspection.sources) {
    if (/(?:^|[/!])(?:00steam|00_maclauncher_steam)\.rpyc?(?::\d+)?$/i.test(item.source)) continue;
    if (item.compiledAssignments) {
      for (const assignment of item.compiledAssignments) {
        if (assignment.python) {
          calls.push(...gameSteamCalls(assignment.python, { python: true }).map(call => ({ ...call, source: assignment.source })));
          assignments.push(...sourceAssignments(assignment.python, assignment.source, { python: true, keys: KEYS, unsafeContext: assignment.unsafeContext }));
        } else assignments.push(assignment);
      }
    } else {
      calls.push(...gameSteamCalls(item.text).map(call => ({ ...call, source: item.source })));
      assignments.push(...sourceAssignments(item.text, item.source, { keys: KEYS }));
    }
  }
  // Negative games do not need an AppID scan or native SDK process.
  if (!calls.length) return { required: false, consumerKind: "renpy-ctypes", calls, inspectionErrors: inspection.errors };
  const enabled = assignments.filter(item => item.key === "enable_steam" && !item.unsafeContext);
  if (enabled.length && enabled.every(item => /^False\s*(?:#.*)?$/.test(item.expression || "")))
    return { required: false, disabled: true, consumerKind: "renpy-ctypes", calls, inspectionErrors: inspection.errors };
  const identity = readGameAppId({ gameRoot, extraRoots: path.resolve(gameDir) === path.resolve(gameRoot) ? [] : [gameDir] });
  const evidence = [...identity.evidence];
  for (const item of assignments.filter(item => item.key === "steam_appid")) {
    const match = /^(\d{1,10})\s*(?:#.*)?$/.exec(item.expression || "");
    const value = !item.unsafeContext && match ? positiveAppId(match[1]) : null;
    if (value) evidence.push({ kind: "renpy-config", value, source: item.source, line: item.line });
  }
  const values = [...new Set(evidence.map(item => item.value))];
  const appId = { ...identity, value: values.length === 1 ? values[0] : null,
    status: values.length > 1 ? "conflict" : values.length === 1 ? "found" : identity.status, evidence };
  const optional = calls.every(call => call.requiredInit === false);
  return { required: !optional || appId.status === "found", optional, consumerKind: "renpy-ctypes", calls, appId,
    ...optional && appId.status !== "found" ? { reason: "steam-identity-unresolved" } : {}, inspectionErrors: inspection.errors };
}

function boundedRegular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("Ren'Py Steam input is not a bounded regular file.");
  return { stat, bytes: fs.readFileSync(file) };
}

function statIfPresent(file) {
  try { return fs.lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function runAbiProbe(python, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const finish = (error, output) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(output); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Ren'Py Steam ABI inspection timed out.")); }, 15_000);
    child.stdout.on("data", bytes => {
      stdout += bytes.toString("utf8");
      if (stdout.length > 1024 * 1024) { child.kill("SIGKILL"); finish(new Error("Ren'Py Steam ABI report exceeds inspection limits.")); }
    });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes.toString("utf8")).slice(-8192); });
    child.once("error", error => finish(error));
    child.once("close", code => finish(code === 0 ? null : new Error(`Ren'Py Steam ABI inspection failed (${code}): ${stderr.trim()}`), stdout));
  });
}

/** The selected trusted runtime supplies its exact eager ctypes bindings. */
async function inspectRuntimeSteamAbi(python, { major, run = runAbiProbe } = {}) {
  if (![7, 8].includes(major)) throw new Error("Choose an explicit Ren'Py 7 or 8 runtime for Steam integration.");
  python = fs.realpathSync(python);
  const libRoot = path.dirname(path.dirname(python));
  const directories = fs.readdirSync(libRoot).filter(name => new RegExp(`^python${major === 7 ? 2 : 3}\\.\\d+$`).test(name));
  if (directories.length !== 1) throw Object.assign(new Error("The selected Ren'Py Python library version is ambiguous."), { code: "RENPY_STEAM_PROVIDER_UNAVAILABLE" });
  const providers = ["steamapi.py", "steamapi.pyc", "steamapi.pyo"].map(name => path.join(libRoot, directories[0], name)).filter(file => fs.existsSync(file));
  if (providers.length !== 1) throw Object.assign(new Error("The selected Ren'Py runtime has no unambiguous Steam API provider."), { code: "RENPY_STEAM_PROVIDER_UNAVAILABLE" });
  const provider = providers[0], before = boundedRegular(provider, 4 * 1024 * 1024), sha256 = digest(before.bytes);
  const key = JSON.stringify([python, fs.statSync(python).mtimeMs, provider, sha256, major]);
  if (abiCache.has(key)) return structuredClone(await abiCache.get(key));
  const task = (async () => {
    const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
    for (const name of ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT"]) delete environment[name];
    // Node can read this source inside app.asar; the external SDK Python cannot
    // open an asar member. Pass source as an argument, without a shell or copy.
    const probeSource = fs.readFileSync(path.join(__dirname, "steam-abi-probe.py"), "utf8");
    const output = await run(python, ["-B", "-c", probeSource, libRoot], { cwd: libRoot, env: environment });
    const report = JSON.parse(output);
    if (report.provider !== provider || report.sha256 !== sha256 || report.python?.[0] !== (major === 7 ? 2 : 3) ||
        !path.isAbsolute(report.executable || "") || path.dirname(report.executable) !== path.dirname(python) ||
        !Array.isArray(report.symbols) || !report.symbols.length || report.symbols.length > 4096 ||
        report.symbols.some(name => typeof name !== "string" || !/^(?:SteamAPI_|SteamInternal_|GetHSteam)[A-Za-z0-9_]{1,160}$/.test(name)) ||
        new Set(report.symbols).size !== report.symbols.length || digest(boundedRegular(provider, 4 * 1024 * 1024).bytes) !== sha256)
      throw new Error("The selected Ren'Py Steam API provider changed during inspection.");
    return report;
  })();
  abiCache.set(key, task);
  while (abiCache.size > 16) abiCache.delete(abiCache.keys().next().value);
  try { return structuredClone(await task); } catch (error) { if (abiCache.get(key) === task) abiCache.delete(key); throw error; }
}

function pythonLiteral(value) {
  return "u" + JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

function bootstrapPython({ python, runtimeExecutable = python, libraryPath, appId, appIdPath }) {
  if (![python, libraryPath, appIdPath].every(file => path.isAbsolute(file || "") && !file.includes("\0")) || !positiveAppId(appId))
    throw new Error("Ren'Py Steam support requires exact native paths and a positive game identity.");
  return ["_constant = True", "import os, sys", "from renpy.store import config",
    `if os.path.realpath(sys.executable) not in [os.path.realpath(${pythonLiteral(python)}), os.path.realpath(${pythonLiteral(runtimeExecutable)})]:`,
    "    raise RuntimeError(\"Ren'Py Steam runtime identity changed.\")",
    "_original_join = getattr(os.path.join, '_maclauncher_steam_original', os.path.join)",
    "_executable_dir = os.path.dirname(os.path.abspath(sys.executable))",
    "_library_source = os.path.normpath(_original_join(_executable_dir, 'libsteam_api.dylib'))",
    "_appid_source = os.path.normpath(_original_join(_executable_dir, 'steam_appid.txt'))",
    `config.steam_appid = ${appId}`,
    "def _steam_join(*args):", "    result = _original_join(*args)",
    "    if os.path.isabs(result):", "        normalized = os.path.normpath(result)",
    `        if normalized == _library_source: return ${pythonLiteral(libraryPath)}`,
    `        if normalized == _appid_source: return ${pythonLiteral(appIdPath)}`,
    "    return result", "_steam_join._maclauncher_steam_original = _original_join", "os.path.join = _steam_join", ""].join("\n");
}

function removeBootstrap(wrapperDir) {
  const receipt = path.join(wrapperDir, RECEIPT), script = path.join(wrapperDir, "game", BOOTSTRAP);
  if (!statIfPresent(receipt)) {
    if (statIfPresent(script)) throw new Error("An unowned Ren'Py Steam bootstrap occupies the private project.");
    return;
  }
  const metadata = JSON.parse(boundedRegular(receipt, 8192).bytes);
  if (metadata.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(metadata.sha256 || "")) throw new Error("The Ren'Py Steam configuration changed.");
  if (statIfPresent(script)) {
    const content = boundedRegular(script, 32 * 1024).bytes;
    if (!content.toString("utf8").startsWith(HEADER) || digest(content) !== metadata.sha256)
      throw new Error("The private Ren'Py Steam bootstrap was modified.");
    fs.rmSync(script);
  }
  fs.rmSync(script + "c", { force: true }); fs.rmSync(receipt);
}

function hasPreparedBootstrap(wrapperDir) {
  if (!wrapperDir) return false;
  try {
    const metadata = JSON.parse(boundedRegular(path.join(wrapperDir, RECEIPT), 8192).bytes);
    const content = boundedRegular(path.join(wrapperDir, "game", BOOTSTRAP), 32 * 1024).bytes;
    return metadata.schemaVersion === 1 && content.toString("utf8").startsWith(HEADER) && digest(content) === metadata.sha256;
  } catch { return false; }
}

function ensureBootstrap(wrapperDir, { gameRoot, python, runtimeExecutable, libraryPath, appId, identity }) {
  ProjectOverlay.assertOutsideOriginal(gameRoot, wrapperDir);
  ProjectOverlay.ensurePrivateDirectory(path.join(wrapperDir, "game"));
  const stateDir = path.join(wrapperDir, ".maclauncher-renpy-steam");
  ProjectOverlay.ensurePrivateDirectory(stateDir);
  const appIdPath = path.join(stateDir, "steam_appid.txt");
  if (statIfPresent(appIdPath)?.isSymbolicLink()) throw new Error("Ren'Py Steam identity files cannot use symlinks.");
  const source = HEADER + "init -1500 python in _maclauncher_steam:\n" + bootstrapPython({ python, runtimeExecutable, libraryPath, appId, appIdPath })
    .split("\n").map(line => line ? "    " + line : "").join("\n");
  const script = path.join(wrapperDir, "game", BOOTSTRAP), sha256 = digest(source);
  const receiptPath = path.join(wrapperDir, RECEIPT);
  if (statIfPresent(script)) {
    const previous = JSON.parse(boundedRegular(receiptPath, 8192).bytes);
    const content = boundedRegular(script, 32 * 1024).bytes;
    if (previous.schemaVersion !== 1 || !content.toString("utf8").startsWith(HEADER) || digest(content) !== previous.sha256)
      throw new Error("The private Ren'Py Steam bootstrap was modified.");
    if (previous.sha256 === sha256) return { script, appIdPath, sha256 };
  }
  fs.writeFileSync(script, source);
  fs.rmSync(script + "c", { force: true });
  fs.writeFileSync(appIdPath, String(appId) + "\n", { mode: 0o600 });
  fs.writeFileSync(receiptPath, JSON.stringify({ schemaVersion: 1, sha256, identity }, null, 2));
  return { script, appIdPath, sha256 };
}

async function prepareGameSteam({ consumer, gameRoot, python, runtimeExecutable, major, arch, wrapperDir, context, baseEnvironment }, { inspectAbi = inspectRuntimeSteamAbi } = {}) {
  if (!consumer?.required || baseEnvironment?.RENPY_NO_STEAM !== undefined) { if (wrapperDir) removeBootstrap(wrapperDir); return null; }
  if (!consumer.appId?.value || consumer.appId.status !== "found") throw new Error("This Ren'Py game uses Steam, but its application ID is missing or conflicting.");
  if (typeof context.prepareSteamApi !== "function") {
    if (consumer.optional) { if (wrapperDir) removeBootstrap(wrapperDir); return null; }
    throw new Error("The native Steam API service is unavailable.");
  }
  let abi, prepared;
  const runtimeDir = path.dirname(python);
  try {
    abi = await inspectAbi(python, { major });
    prepared = await context.prepareSteamApi({ required: true, appId: consumer.appId, arch, symbols: abi.symbols,
      aliases: ["libsteam_api.dylib"], nativeLibraryPaths: [path.join(runtimeDir, "libsteam_api.dylib"), path.join(gameRoot, "libsteam_api.dylib")] }, { baseEnvironment });
  } catch (error) {
    if (consumer.optional && ["RENPY_STEAM_PROVIDER_UNAVAILABLE", "STEAM_API_UNAVAILABLE", "STEAM_API_SYMBOLS_UNAVAILABLE"].includes(error.code)) {
      if (wrapperDir) removeBootstrap(wrapperDir);
      context.logger?.info?.(`[runtime] optional Ren'Py Steam API unavailable (${error.code})`);
      return null;
    }
    throw error;
  }
  if (!prepared?.libraryPath || !prepared.environment) throw new Error("The native Steam API library is unavailable.");
  const bootstrap = ensureBootstrap(wrapperDir, { gameRoot, python: abi.executable, runtimeExecutable, libraryPath: prepared.libraryPath,
    appId: consumer.appId.value, identity: { ...prepared.identity, providerSha256: abi.sha256 } });
  return { ...prepared, bootstrap, abi };
}

module.exports = { BOOTSTRAP, maskStrings, gameSteamCalls, inspectGameSteamConsumer, inspectRuntimeSteamAbi,
  bootstrapPython, ensureBootstrap, removeBootstrap, hasPreparedBootstrap, prepareGameSteam };
