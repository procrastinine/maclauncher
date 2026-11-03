import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const { embeddedPythonProfile } = createRequire(import.meta.url)("../src/modules/shared/runtime/python.js");
const Host = createRequire(import.meta.url)("../src/modules/shared/runtime/host-capabilities.js");
const ARCHITECTURES = Object.freeze({ arm64: "arm64", aarch64: "arm64", x64: "x64", x86_64: "x64" });
export function assertPythonBuildHost(arch, host = Host.getHostCapabilities()) {
  if (host.platform !== "darwin" || arch === "arm64" && host.hardwareArch !== "arm64")
    throw new Error("The Apple Silicon Python build installs on an Apple Silicon Mac.");
}
export function verifyArchive(file, pin) {
  if (!fs.lstatSync(file).isFile() || crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== pin.sha256)
    throw new Error("Python build input does not match its pinned SHA-256.");
}
async function download(url, target, pin) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Python build input download failed (${response.status}).`);
  const temporary = target + ".download-" + process.pid;
  try {
    fs.writeFileSync(temporary, Buffer.from(await response.arrayBuffer()), { flag: "wx" });
    verifyArchive(temporary, pin);
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
export function copyPythonTree(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(source)) copyPythonTree(path.join(source, name), path.join(destination, name));
  } else {
    fs.copyFileSync(fs.realpathSync(source), destination);
    fs.chmodSync(destination, stat.mode & 0o777);
  }
}

function pickBundledPythonName(binDir) {
  const candidates = ["python3", "python3.12", "python3.11", "python3.10", "python"];
  for (const name of candidates) {
    if (fs.existsSync(path.join(binDir, name))) return name;
  }
  return null;
}

function normalizePythonEntrypoints(destDir) {
  const binDir = path.join(destDir, "bin");
  if (!fs.existsSync(binDir)) return;
  const pythonName = pickBundledPythonName(binDir);
  if (!pythonName) return;

  let entries = [];
  try {
    entries = fs.readdirSync(binDir, { withFileTypes: true });
  } catch {
    return;
  }

  const header = [
    "#!/bin/sh",
    `'''exec' "$(dirname -- "$(realpath -- "$0")")/${pythonName}" "$0" "$@"`,
    "' '''"
  ].join("\n");

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(binDir, entry.name);
    let fd;
    try {
      fd = fs.openSync(filePath, "r");
      const buf = Buffer.alloc(2);
      const read = fs.readSync(fd, buf, 0, 2, 0);
      fs.closeSync(fd);
      if (read < 2 || buf[0] !== 0x23 || buf[1] !== 0x21) continue;
    } catch {
      if (fd) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    if (content.startsWith("#!/bin/sh\n'''exec'")) continue;

    const firstNewline = content.indexOf("\n");
    const firstLine = firstNewline === -1 ? content : content.slice(0, firstNewline);
    if (!firstLine.includes("python")) continue;

    const rest = firstNewline === -1 ? "" : content.slice(firstNewline + 1);
    const normalized = `${header}\n${rest}`;
    if (normalized !== content) {
      fs.writeFileSync(filePath, normalized, "utf8");
    }
  }
}

// Installs the publisher build for one app architecture. The Intel build runs
// under Rosetta on Apple Silicon while its pinned packages are installed.
export async function main(argv = process.argv.slice(2)) {
  // Select the invoking process's publisher build by default, including under Rosetta.
  let dest = "src/resources/python", arch = process.arch;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i], value = argv[++i];
    if (!value) throw new Error("A Python setup option is missing its value.");
    if (name === "--dest") dest = value;
    else if (name === "--version" && ["3.12.15", "3.12"].includes(value)) continue;
    else if (name === "--arch" && Object.hasOwn(ARCHITECTURES, value)) arch = ARCHITECTURES[value];
    else throw new Error("Unsupported Python setup option or pinned version.");
  }
  const PIN = embeddedPythonProfile(arch);
  assertPythonBuildHost(arch);
  const destination = path.resolve(dest), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-python-"));
  try {
    const cache = path.resolve("dist/upstream-downloads");
    fs.mkdirSync(cache, { recursive: true });
    const archive = path.join(cache, PIN.sha256 + ".tar.gz"), extracted = path.join(temporary, "input");
    if (fs.existsSync(archive)) verifyArchive(archive, PIN);
    else await download(PIN.url, archive, PIN);
    fs.mkdirSync(extracted); run("/usr/bin/tar", ["-xzf", archive, "-C", extracted]);
    const staged = path.join(temporary, "prepared");
    copyPythonTree(path.join(extracted, "python"), staged);
    const wheels = path.join(temporary, "wheels"); fs.mkdirSync(wheels);
    for (const pin of PIN.packages) await download(pin.url, path.join(wheels, pin.filename), pin);
    const requirements = path.join(temporary, "requirements.txt");
    fs.writeFileSync(requirements, PIN.packages.map(pin => pin.name + "==" + pin.version + " --hash=sha256:" + pin.sha256).join("\n") + "\n");
    const python = path.join(staged, "bin", "python3");
    run(python, ["-I", "-m", "pip", "--disable-pip-version-check", "install", "--no-cache-dir", "--no-compile", "--no-deps",
      "--require-hashes", "--only-binary=:all:", "--no-index", "--find-links", wheels, "--requirement", requirements],
      { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    normalizePythonEntrypoints(staged);
    run(python, ["-I", "-c", `import sys, ctypes, platform, pefile, aplib, corrupy; assert sys.version_info[:3] == (${PIN.version.split(".").join(", ")}) and platform.machine() == ${JSON.stringify(PIN.architecture)}`]);
    fs.writeFileSync(path.join(staged, "runtime.json"), JSON.stringify(PIN, null, 2) + "\n");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const backup = fs.existsSync(destination) ? destination + "-old-" + Date.now() : null;
    if (backup) fs.renameSync(destination, backup);
    try { copyPythonTree(staged, destination); }
    catch (error) { fs.rmSync(destination, { recursive: true, force: true }); if (backup) fs.renameSync(backup, destination); throw error; }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    console.log("Embedded Python " + PIN.version + " (" + PIN.architecture + ") installed at " + destination);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
