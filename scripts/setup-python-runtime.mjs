import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
  const args = { version: "3.12", dest: "src/resources/python", arch: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--version" && argv[i + 1]) {
      args.version = argv[i + 1];
      i += 1;
    } else if (arg === "--dest" && argv[i + 1]) {
      args.dest = argv[i + 1];
      i += 1;
    } else if (arg === "--arch" && argv[i + 1]) {
      args.arch = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function httpGetJson(url, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while fetching JSON");
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "maclauncher",
          "Accept": "application/vnd.github+json"
        }
      },
      res => {
        const status = Number(res.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(status)) {
          const loc = res.headers.location;
          res.resume();
          if (!loc) {
            reject(new Error(`Redirect missing location: ${url}`));
            return;
          }
          const nextUrl = new URL(loc, url).toString();
          resolve(httpGetJson(nextUrl, redirectDepth + 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`Request failed (${status})`));
          return;
        }
        const chunks = [];
        res.on("data", c => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function downloadFile(url, destPath, redirectDepth = 0) {
  if (redirectDepth > 5) throw new Error("Too many redirects while downloading");
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, res => {
        const status = Number(res.statusCode || 0);
        if ([301, 302, 303, 307, 308].includes(status)) {
          const loc = res.headers.location;
          res.resume();
          file.close();
          if (!loc) {
            reject(new Error(`Redirect missing location: ${url}`));
            return;
          }
          const nextUrl = new URL(loc, url).toString();
          resolve(downloadFile(nextUrl, destPath, redirectDepth + 1));
          return;
        }
        if (status !== 200) {
          res.resume();
          file.close();
          reject(new Error(`Download failed (${status})`));
          return;
        }
        res.pipe(file);
        file.on("finish", resolve);
      })
      .on("error", reject);
  });
}

function parseSemver(v) {
  const m = String(v || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareSemverDesc(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return String(b || "").localeCompare(String(a || ""));
  for (let i = 0; i < 3; i += 1) {
    const d = pb[i] - pa[i];
    if (d !== 0) return d;
  }
  return 0;
}

function normalizeVersionInput(input) {
  const raw = String(input || "").trim().replace(/^v/i, "");
  if (!raw) return null;
  const parts = raw.split(".").map(p => p.trim()).filter(Boolean);
  if (parts.length >= 3) return parts.slice(0, 3).join(".");
  if (parts.length === 2) return `${parts[0]}.${parts[1]}`;
  return null;
}

function parseAssetName(name) {
  const m = String(name || "").match(
    /^cpython-(\d+\.\d+\.\d+)\+[^-]+-([^-]+)-apple-darwin-(.+)\.tar\.gz$/i
  );
  if (!m) return null;
  return { version: m[1], arch: m[2], flavor: m[3] };
}

function pickAsset(assets, { version, arch }) {
  const normalized = normalizeVersionInput(version);
  const desiredParts = normalized ? normalized.split(".") : [];
  const majorMinor = desiredParts.length === 2 ? normalized : null;
  const exact = desiredParts.length === 3 ? normalized : null;
  const archOrder = [];

  if (arch) {
    archOrder.push(arch);
  } else {
    archOrder.push("universal2");
    archOrder.push(process.arch === "arm64" ? "aarch64" : "x86_64");
  }

  const candidates = assets
    .map(asset => ({ asset, parsed: parseAssetName(asset.name) }))
    .filter(item => item.parsed && String(item.parsed.flavor || "").includes("install_only"));

  const filtered = candidates.filter(item => {
    if (exact) return item.parsed.version === exact;
    if (majorMinor) return item.parsed.version.startsWith(`${majorMinor}.`);
    return item.parsed.version.startsWith("3.12.");
  });

  filtered.sort((a, b) => compareSemverDesc(a.parsed.version, b.parsed.version));

  for (const preferredArch of archOrder) {
    const match = filtered.find(item => item.parsed.arch === preferredArch);
    if (match) return match;
  }

  return filtered[0] || null;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    throw new Error(`${cmd} failed (${result.status})`);
  }
}

function findPythonRoot(rootDir) {
  const direct = path.join(rootDir, "bin", "python3");
  if (fs.existsSync(direct)) return rootDir;
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(rootDir, entry.name);
    if (fs.existsSync(path.join(candidate, "bin", "python3"))) return candidate;
  }
  return null;
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

async function main() {
  const args = parseArgs(process.argv);
  const destDir = path.resolve(args.dest);
  const latest = await httpGetJson(
    "https://api.github.com/repos/indygreg/python-build-standalone/releases/latest"
  );
  const releaseList = Array.isArray(latest) ? latest : [latest];

  const assets = [];
  for (const release of releaseList || []) {
    for (const asset of release?.assets || []) {
      if (asset?.name && asset?.browser_download_url) {
        assets.push({ name: asset.name, url: asset.browser_download_url });
      }
    }
  }
  let selected = pickAsset(assets, { version: args.version, arch: args.arch });
  if (!selected) {
    const releases = await httpGetJson(
      "https://api.github.com/repos/indygreg/python-build-standalone/releases?per_page=10"
    );
    const fallbackAssets = [];
    for (const release of releases || []) {
      for (const asset of release?.assets || []) {
        if (asset?.name && asset?.browser_download_url) {
          fallbackAssets.push({ name: asset.name, url: asset.browser_download_url });
        }
      }
    }
    selected = pickAsset(fallbackAssets, { version: args.version, arch: args.arch });
  }
  if (!selected) {
    throw new Error(`No Python build asset found for ${args.version}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-python-"));
  const archivePath = path.join(tmpDir, selected.asset.name);
  const extractDir = path.join(tmpDir, "extract");

  try {
    console.log(`Downloading ${selected.asset.name}`);
    await downloadFile(selected.asset.url, archivePath);

    fs.mkdirSync(extractDir, { recursive: true });
    run("/usr/bin/tar", ["-xzf", archivePath, "-C", extractDir]);

    const pythonRoot = findPythonRoot(extractDir);
    if (!pythonRoot) throw new Error("Extracted Python root not found");

    if (fs.existsSync(destDir)) {
      const backup = `${destDir}-old-${Date.now()}`;
      fs.renameSync(destDir, backup);
      console.log(`Existing python moved to ${backup}`);
    }

    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(pythonRoot, destDir, { recursive: true, dereference: true });

    const pythonBin = path.join(destDir, "bin", "python3");
    try {
      const stat = fs.lstatSync(pythonBin);
      if (stat.isSymbolicLink()) {
        throw new Error("python3 remained a symlink after copy");
      }
    } catch {}
    console.log("Bootstrapping pip");
    run(pythonBin, ["-m", "ensurepip", "--upgrade"]);
    run(pythonBin, ["-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"]);
    run(pythonBin, ["-m", "pip", "install", "pefile", "aplib"]);
    normalizePythonEntrypoints(destDir);

    console.log(`Embedded Python installed at ${destDir}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err?.message || err);
  process.exit(1);
});
