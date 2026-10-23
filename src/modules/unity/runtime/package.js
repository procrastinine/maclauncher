const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Native = require("../../shared/runtime/local-native");
const { throwIfAborted } = require("../../shared/runtime/download-utils");
const { VERSION } = require("../detect");
const exec = promisify(execFile);
const IDENTITY = "Unity Technologies ApS (BVPN9UFA9B)";
const safeRelative = value => value && !path.isAbsolute(value) && !value.split(path.sep).includes("..") && !/[\x00-\x1f]/.test(value);

async function verifyArtifact({ archivePath, archiveSha256, pin, signal }, { run = exec } = {}) {
  const { stdout } = await run("/usr/sbin/pkgutil", ["--check-signature", archivePath], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 30000, ...(signal ? { signal } : {}), env: { ...process.env, LANG: "C", LC_ALL: "C" } });
  throwIfAborted(signal);
  const expected = pin?.asset?.publisherIdentity || IDENTITY;
  const signer = /\d+\. Developer ID Installer:\s*([^\n]+)/.exec(stdout)?.[1]?.trim();
  if (!/Status:\s+signed by a developer certificate issued by Apple for distribution/.test(stdout) ||
    signer !== expected || ![IDENTITY, "Unity Technologies ApS"].includes(expected) || !stdout.includes("Apple Root CA")) throw new Error("The Unity installer signature is not a trusted Unity Technologies package.");
  const leaf = /Developer ID Installer:[\s\S]*?SHA256 Fingerprint:\s*((?:[A-Fa-f0-9]{2}\s+){31}[A-Fa-f0-9]{2})/.exec(stdout);
  const timestamp = /Signed with a trusted timestamp on:\s*([^\n]+)/.exec(stdout)?.[1]?.trim() || null;
  if (!leaf) throw new Error("The Unity installer's signing certificate identity was not readable.");
  const certificateSha256 = leaf[1].replace(/\s/g, "").toLowerCase();
  if ((pin?.asset?.publisherCertificateSha256 && certificateSha256 !== pin.asset.publisherCertificateSha256) ||
    (expected === "Unity Technologies ApS" && !pin?.asset?.publisherCertificateSha256)) throw new Error("The Unity installer signing certificate does not match this release.");
  return { verified: true, archiveSha256, identity: expected, certificateSha256, trustedTimestamp: timestamp, verificationTool: "/usr/sbin/pkgutil --check-signature" };
}

async function extractPackage(archivePath, destination, signal, { run = exec } = {}) {
  const expanded = path.join(destination, ".package");
  await run("/usr/sbin/pkgutil", ["--expand-full", archivePath, expanded], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 300000, ...(signal ? { signal } : {}) });
  throwIfAborted(signal);
  // pkgutil expands payloads only. Installer scripts, license plugins and
  // postinstall programs are never executed or published as a runtime.
}

function findPayload(root) {
  const found = [];
  function walk(directory, depth = 0) {
    if (depth > 4) return;
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).slice(0, 128)) {
      if (!item.isDirectory()) continue;
      const file = path.join(directory, item.name);
      if (item.name === "Payload" && fs.existsSync(path.join(file, "Variations"))) found.push(file);
      else walk(file, depth + 1);
    }
  }
  walk(root);
  if (found.length !== 1) throw new Error("The Unity component does not contain one supported Mac player payload.");
  return found[0];
}

function engineIdentity(frameworkPath) {
  const stat = fs.statSync(frameworkPath);
  if (!stat.isFile() || stat.size < 1024 || stat.size > 256 * 1024 * 1024) throw new Error("Unity engine framework size is unsupported.");
  Native.readMachOArchitectures(frameworkPath, { allowLibrary: true });
  // Exact full-version/revision strings are embedded in the native engine.
  // Installation/import can afford this read; ordinary detection never scans it.
  const text = fs.readFileSync(frameworkPath).toString("latin1"), found = new Map();
  for (const match of text.matchAll(/(?:^|\x00)(\d{1,4}\.\d{1,3}\.\d{1,4}[abfp]\d{1,4}) \(([a-f0-9]{12,40})\)(?:\x00|$)/g)) {
    if (VERSION.test(match[1])) found.set(match[1] + ":" + match[2], { version: match[1], revision: match[2] });
  }
  if (found.size !== 1) throw new Error("The native Unity engine does not report one exact editor version and revision.");
  return [...found.values()][0];
}

function inventory(root) {
  const files = {}, symlinks = {}; let count = 0, totalBytes = 0;
  function walk(directory, relative = "", depth = 0) {
    if (depth > 16) throw new Error("Unity runtime directory nesting is unsupported.");
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? path.join(relative, item.name) : item.name, file = path.join(directory, item.name);
      if (!safeRelative(name) || ++count > 5000) throw new Error("Unity runtime inventory is invalid or too large.");
      if (item.isDirectory()) walk(file, name, depth + 1);
      else if (item.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (!safeRelative(target) || !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error("Unity runtime symlink escapes its installation.");
        symlinks[name] = target;
      } else if (item.isFile()) {
        totalBytes += fs.statSync(file).size;
        if (totalBytes > 512 * 1024 * 1024) throw new Error("Unity player runtime exceeds its supported size.");
        files[name] = Native.hashFile(file);
      }
    }
  }
  walk(root); return { files, symlinks, totalBytes };
}

function verifyInventory(root, record) {
  if (!record?.files || !record.symlinks || Object.keys(record.files).length + Object.keys(record.symlinks).length > 5000) return false;
  try {
    for (const [relative, hash] of Object.entries(record.files)) {
      if (!safeRelative(relative) || !/^[a-f0-9]{64}$/.test(hash) || Native.hashFile(path.join(root, relative)) !== hash) return false;
    }
    for (const [relative, target] of Object.entries(record.symlinks)) {
      if (!safeRelative(relative) || !safeRelative(target) || fs.readlinkSync(path.join(root, relative)) !== target) return false;
    }
    return true;
  } catch { return false; }
}

async function prepareInstall({ unpacked, pin, signal, logger }, { run = exec } = {}) {
  const payload = findPayload(path.join(unpacked, ".package"));
  const variations = fs.readdirSync(path.join(payload, "Variations"), { withFileTypes: true }).filter(item => item.isDirectory() && /^(?:macosx64|macosarm64)(?:_player)?_nondevelopment_mono$/.test(item.name));
  variations.sort((a, b) => Number(b.name.includes(process.arch === "arm64" ? "arm64" : "x64")) - Number(a.name.includes(process.arch === "arm64" ? "arm64" : "x64")));
  if (!variations.length) throw new Error("This Unity component has no supported nondevelopment Mono player template.");
  const variation = path.join(payload, "Variations", variations[0].name), sourceApp = path.join(variation, "UnityPlayer.app"), destination = path.join(unpacked, "player", "UnityPlayer.app");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(sourceApp, destination, { recursive: true, verbatimSymlinks: true });
  const contents = path.join(destination, "Contents"), frameworks = path.join(contents, "Frameworks");
  const fused = !fs.existsSync(path.join(frameworks, "UnityPlayer.dylib")), identity = engineIdentity(fused ? path.join(contents, "MacOS", "UnityPlayer") : path.join(frameworks, "UnityPlayer.dylib"));
  if (identity.version !== pin.version || identity.revision !== pin.upstreamRevision) throw new Error("The downloaded Unity player version/revision does not match the selected release.");
  for (const name of ["libmonobdwgc-2.0.dylib", "libMonoPosixHelper.dylib"]) {
    const from = path.join(payload, "Frameworks", name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(frameworks, name));
  }
  const mono = path.join(payload, "MonoBleedingEdge");
  if (fs.existsSync(mono)) fs.cpSync(mono, path.join(contents, "MonoBleedingEdge"), { recursive: true, verbatimSymlinks: true });
  if (fused ? !fs.existsSync(path.join(frameworks, "MonoEmbedRuntime", "osx", "libmono.0.dylib")) || !fs.existsSync(path.join(contents, "Data", "Managed", "etc", "mono", "config"))
    : !fs.existsSync(path.join(frameworks, "libmonobdwgc-2.0.dylib")) || !fs.existsSync(path.join(contents, "MonoBleedingEdge", "etc", "mono", "config"))) throw new Error("The Unity Mono player component is incomplete.");
  const architectures = Native.readMachOArchitectures(path.join(contents, "MacOS", "UnityPlayer"));
  const requested = process.arch === "x64" ? "x86_64" : process.arch;
  if (!architectures.includes(requested) && !(requested === "arm64" && architectures.includes("x86_64"))) throw new Error("The Unity player template does not support this Mac's CPU.");
  const plistPath = path.join(contents, "Info.plist");
  const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>UnityPlayer</string><key>CFBundleIdentifier</key><string>com.maclauncher.unity.player</string><key>CFBundleName</key><string>Unity Player</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${pin.version}</string><key>CFBundleVersion</key><string>${pin.upstreamRevision}</string><key>NSMainNibFile</key><string>MainMenu</string><key>NSPrincipalClass</key><string>PlayerApplication</string><key>LSMinimumSystemVersion</key><string>${pin.minimumMacOS || "10.13"}</string></dict></plist>`;
  fs.writeFileSync(plistPath, plist);
  throwIfAborted(signal);
  // Build-support templates are unsigned, unlike the signed installer that
  // authenticates them. Sign only this owned template for native execution.
  const nativeSignature = await run("/usr/bin/codesign", ["--display", "--verbose=4", path.join(contents, "MacOS", "UnityPlayer")], { encoding: "utf8", maxBuffer: 64 * 1024 }).then(result => ({ status: "signed", detail: result.stderr.slice(0, 4096) })).catch(error => ({ status: /not signed at all/.test(error.stderr || "") ? "unsigned-template" : "unverified", detail: String(error.stderr || error.message).slice(0, 4096) }));
  await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", destination], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 60000, ...(signal ? { signal } : {}) });
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", destination], { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 30000, ...(signal ? { signal } : {}) });
  fs.rmSync(path.join(unpacked, ".package"), { recursive: true, force: true });
  const profileRoot = path.join(unpacked, "player"), profile = { schemaVersion: 1, version: pin.version, revision: pin.upstreamRevision, scriptingBackend: "mono",
    templateRelative: "UnityPlayer.app", templateVariation: variations[0].name, playerLayout: fused ? "fused-mono" : "framework-mono",
    dataDirectory: fused ? "Data" : "Resources/Data", architectures, nativeSignature, localSigning: "ad-hoc", ...inventory(profileRoot) };
  const profilePath = path.join(unpacked, "player-profile.json");
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));
  logger?.info?.(`[unity] installed exact Mono player ${pin.version}/${pin.upstreamRevision}; ${profile.totalBytes} bytes, ${architectures.join("/")}`);
  return { profile: "unity-exact-mono-player-v1", profileSha256: Native.hashFile(profilePath), version: pin.version,
    sourceRevision: pin.upstreamRevision, templateVariation: profile.templateVariation, architectures,
    nativeSignature, localSigning: "ad-hoc", totalBytes: profile.totalBytes };
}

module.exports = { IDENTITY, verifyArtifact, extractPackage, findPayload, engineIdentity, inventory, verifyInventory, prepareInstall, safeRelative };
