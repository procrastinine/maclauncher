const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { promisify } = require("node:util"), execute = promisify(require("node:child_process").execFile);
const Python = require("./python"), Embedded = require("./embedded-python.json");
const { assertOwnDirectory } = require("../writable-input");
const { throwIfAborted } = require("./download-utils");

const pending = new Map(), identities = new Map();
const probe = "import sys,sysconfig,platform,json;print(json.dumps(dict(version=list(sys.version_info[:3]),abi=sysconfig.get_config_var('SOABI'),architecture=platform.machine())))";
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const includedVersion = Embedded.version.split(".").slice(0, 2).join(".");
const siteRelative = `lib/python${includedVersion}/site-packages`, pathFile = "maclauncher-runtime.pth", packageLink = "runtime-packages";

function environment(extra = {}) {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PYTHON"))), ...extra,
    PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
}
function fileIdentity(file) {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile()) throw new Error("The included Python interpreter is unavailable.");
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].join(":");
}
async function includedPython(requirement, { signal, run = execute } = {}) {
  if (!requirement || requirement.abi !== Embedded.abi || requirement.architecture !== Embedded.architecture || requirement.version !== includedVersion)
    throw new Error("This runtime requires a compatible included Python interpreter.");
  const root = Python.resolveEmbeddedPythonRoot(), selected = Python.resolveEmbeddedPythonBinary(root);
  if (!selected) throw new Error("The launcher's included Python is unavailable.");
  const executablePath = fs.realpathSync(selected), identity = fileIdentity(executablePath), key = executablePath + ":" + identity;
  let actual = identities.get(key);
  if (!actual) {
    const result = await run(executablePath, ["-I", "-B", "-c", probe], { signal, env: environment(), timeout: 10000, maxBuffer: 4096 });
    actual = JSON.parse(result.stdout);
    if (actual.abi !== requirement.abi || actual.architecture !== requirement.architecture || actual.version?.slice(0, 2).join(".") !== requirement.version)
      throw new Error("The included Python interpreter does not match this runtime's ABI.");
    if (identities.size >= 16) identities.delete(identities.keys().next().value);
    identities.set(key, actual);
  }
  return { executablePath, identity, ...actual };
}
function inspect(root, receipt) {
  try {
    const stored = path.join(root, "environment.json"), stat = fs.lstatSync(stored);
    assertOwnDirectory(root, path.join(root, "bin"), { create: false });
    assertOwnDirectory(root, path.join(root, siteRelative), { create: false });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || JSON.stringify(JSON.parse(fs.readFileSync(stored))) !== JSON.stringify(receipt)) return null;
    const pythonPath = path.join(root, "bin/python3"), config = path.join(root, "pyvenv.cfg"), site = path.join(root, siteRelative);
    const values = Object.fromEntries(fs.readFileSync(config, "utf8").split(/\r?\n/).filter(line => line.includes("=")).map(line => {
      const at = line.indexOf("="); return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }));
    if (!fs.lstatSync(config).isFile() || fs.lstatSync(config).isSymbolicLink() || values["include-system-site-packages"] !== "false" ||
        values.home !== path.dirname(receipt.python.executablePath) ||
        !fs.lstatSync(pythonPath).isSymbolicLink() || fs.realpathSync(pythonPath) !== receipt.python.executablePath ||
        fs.readdirSync(site).sort().join("\0") !== [pathFile, packageLink].sort().join("\0") ||
        !fs.lstatSync(path.join(site, packageLink)).isSymbolicLink() || fs.realpathSync(path.join(site, packageLink)) !== receipt.packagesRoot ||
        !fs.lstatSync(path.join(site, pathFile)).isFile() || fs.lstatSync(path.join(site, pathFile)).isSymbolicLink() ||
        fs.readFileSync(path.join(site, pathFile), "utf8") !== packageLink + "\n") return null;
    return { root, pythonPath, basePythonPath: receipt.python.executablePath, packagesRoot: receipt.packagesRoot,
      env: environment({ VIRTUAL_ENV: root, PATH: path.dirname(pythonPath) + path.delimiter + (process.env.PATH || "") }) };
  } catch { return null; }
}

/** An owned venv shares the included interpreter and standard library. Only the
 * selected immutable runtime packages enter its site directory, including in
 * upstream subprocesses launched through sys.executable or PATH's python3. */
async function ensureEnvironment({ userDataDir, id, version, packagesRoot, payloadIdentity, requirement, signal }, dependencies = {}) {
  if (!path.isAbsolute(userDataDir || "") || !/^[a-z0-9-]+$/.test(id || "") || typeof version !== "string" || !version ||
      !/^[a-f0-9]{64}$/.test(payloadIdentity || "") || !path.isAbsolute(packagesRoot || "") || !fs.statSync(packagesRoot).isDirectory()) throw new Error("Isolated Python requires a managed runtime and its package directory.");
  throwIfAborted(signal);
  const python = await includedPython(requirement, { signal, run: dependencies.execute });
  const receipt = { schemaVersion: 1, id, version, python, packagesRoot: fs.realpathSync(packagesRoot), payloadIdentity, requirement };
  const parent = path.join(userDataDir, "runtimes", "python-environments", id), root = path.join(parent, digest(receipt));
  assertOwnDirectory(userDataDir, parent);
  const existing = inspect(root, receipt); if (existing) return existing;
  if (pending.has(root)) return pending.get(root);
  const task = (async () => {
    const temporary = fs.mkdtempSync(path.join(parent, ".environment-"));
    try {
      await (dependencies.execute || execute)(python.executablePath, ["-I", "-B", "-m", "venv", "--without-pip", "--symlinks", temporary],
        { signal, env: environment(), timeout: 30000, maxBuffer: 65536 });
      const site = path.join(temporary, siteRelative); assertOwnDirectory(temporary, site);
      fs.symlinkSync(receipt.packagesRoot, path.join(site, packageLink), "dir");
      fs.writeFileSync(path.join(site, pathFile), packageLink + "\n");
      fs.writeFileSync(path.join(temporary, "environment.json"), JSON.stringify(receipt));
      if (!inspect(temporary, receipt)) throw new Error("The isolated Python environment did not retain its selected interpreter and packages.");
      throwIfAborted(signal);
      // A second worker may have completed this same environment. Changed
      // existing environments are retained separately while rebuilding.
      if (fs.existsSync(root)) {
        const winner = inspect(root, receipt); if (winner) return winner;
        fs.renameSync(root, root + ".previous-" + crypto.randomUUID());
      }
      try { fs.renameSync(temporary, root); }
      catch (error) { if (!inspect(root, receipt)) throw error; }
      const result = inspect(root, receipt);
      if (!result) throw new Error("The isolated Python environment is unavailable.");
      return result;
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  })();
  pending.set(root, task);
  try { return await task; } finally { pending.delete(root); }
}

module.exports = { ensureEnvironment, includedPython };
