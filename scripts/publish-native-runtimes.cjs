#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const B = require("../src/modules/shared/runtime/bundled-native");
const { verifyPackages } = require("./verify-native-runtimes.cjs");

function publishPackages({ sourceRoot, resourceRoot = path.resolve(__dirname, "../src/resources/native-runtimes"), supplementals, ...options }) {
  if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot)) throw new Error("An absolute staged package directory is required.");
  const source = fs.realpathSync(sourceRoot), destination = path.resolve(resourceRoot);
  if (source === destination || source.startsWith(destination + path.sep) || destination.startsWith(source + path.sep)) throw new Error("Staged packages and resource output must be separate directories.");
  const S = require("./native-supplementals.cjs");
  const architectures = options.architectures || [process.arch], maximumMacOS = options.maximumMacOS || "13.0";
  const supplementalOnly = Array.isArray(options.managerIds) && options.managerIds.length === 0;
  if (supplementalOnly && (!Array.isArray(supplementals) || !supplementals.length)) throw new Error("Supplemental publication needs an explicit nonempty resource list.");
  const selectedSupplementals = supplementals || (!options.managerIds ? [...new Map(architectures.flatMap(arch =>
    S.requirements({ arch, maximumMacOS }, options.dependencies)).map(item => [item.directoryRelative, item])).values()] : []);
  if (selectedSupplementals.some(item => !architectures.some(arch => item.launcherArchitectures.includes(arch)))) throw new Error("Supplemental native resources do not cover a requested release CPU.");
  const verifySupplementals = resourceRoot => architectures.forEach(arch => S.verifySupplementals({ resourceRoot, arch, maximumMacOS,
    items: selectedSupplementals.filter(item => item.launcherArchitectures.includes(arch)), dependencies: options.dependencies }));
  const reviewed = supplementalOnly ? [] : verifyPackages({ ...options, resourceRoot: source });
  verifySupplementals(source);
  const prepared = [], committed = [];
  let verifiedComplete = false;
  try {
  for (const result of reviewed) {
    const from = path.join(source, B.relativeFile(result.directoryRelative)), target = path.join(destination, result.managerId, result.version, result.arch);
    B.realDirectory(path.dirname(target), { create: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(target), ".publish-")), previous = `${target}.previous-${crypto.randomUUID()}`;
    const job = { target, staging, previous }; prepared.push(job);
      const stored = B.readRegular(path.join(from, "manifest.json"), B.LIMITS.manifestBytes);
      if (stored.sha256 !== result.manifestSha256) throw new Error("Staged manifest changed before publication.");
      const manifest = JSON.parse(stored.bytes);
      fs.writeFileSync(path.join(staging, "manifest.json"), stored.bytes, { flag: "wx", mode: 0o644 });
      for (const file of manifest.files) {
        const bytes = B.readRegular(path.join(from, "files", file.path), file.size);
        if (bytes.size !== file.size || bytes.sha256 !== file.sha256) throw new Error("Staged runtime changed during publication.");
        const copy = path.join(staging, "files", file.path);
        B.realDirectory(path.dirname(copy), { create: true });
        fs.writeFileSync(copy, bytes.bytes, { flag: "wx", mode: file.mode }); fs.chmodSync(copy, file.mode);
      }
      B.verifyPayload(path.join(staging, "files"), manifest);
  }
  for (const item of selectedSupplementals) {
    const from = path.join(source, B.relativeFile(item.directoryRelative)), target = path.join(destination, item.directoryRelative);
    B.realDirectory(path.dirname(target), { create: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(target), ".publish-")), previous = `${target}.previous-${crypto.randomUUID()}`;
    const job = { target, staging, previous }; prepared.push(job);
    for (const file of item.files) {
      const stored = B.readRegular(path.join(from, file.path), file.size);
      if (stored.size !== file.size || stored.sha256 !== file.sha256 || stored.mode !== file.mode) throw new Error("Staged supplemental native resource changed during publication.");
      const copy = path.join(staging, file.path); B.realDirectory(path.dirname(copy), { create: true });
      fs.writeFileSync(copy, stored.bytes, { flag: "wx", mode: file.mode }); fs.chmodSync(copy, file.mode);
    }
    B.verifyPayload(staging, item);
  }
  // Prepare every selected version before publishing any, then retain rollback
  // directories until verification of the complete destination succeeds.
  for (const job of prepared) {
    B.realDirectory(path.dirname(job.target));
    if (fs.existsSync(job.target)) fs.renameSync(job.target, job.previous);
    try { fs.renameSync(job.staging, job.target); }
    catch (error) { if (fs.existsSync(job.previous)) fs.renameSync(job.previous, job.target); throw error; }
    committed.push(job);
  }
  const verified = supplementalOnly ? [] : verifyPackages({ ...options, resourceRoot: destination });
  verifySupplementals(destination);
  verifiedComplete = true;
  for (const job of committed) fs.rmSync(job.previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return verified;
  } catch (error) {
    // Once cleanup has removed a backup, rolling back the complete verified
    // publication could delete that package without restoring its predecessor.
    if (!verifiedComplete) {
      for (const job of committed.reverse()) {
        fs.rmSync(job.target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        if (fs.existsSync(job.previous)) fs.renameSync(job.previous, job.target);
      }
    }
    throw error;
  } finally {
    for (const job of prepared) fs.rmSync(job.staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || !args[index + 1]) throw new Error("Usage: node scripts/publish-native-runtimes.cjs --source <staged> [--output <native-runtimes>] [--arch arm64,x64] [--only id,id] [--maximum-macos 13.0] [--sign-identity <identity>]");
    options[args[index].slice(2)] = args[index + 1];
  }
  for (const result of publishPackages({ sourceRoot: options.source && path.resolve(options.source), resourceRoot: options.output && path.resolve(options.output),
    architectures: options.arch?.split(","), managerIds: options.only?.split(","), versions: options.versions?.split(","), maximumMacOS: options["maximum-macos"] || "13.0", signingIdentity: options["sign-identity"] })) console.log(JSON.stringify(result));
}

if (require.main === module) { try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
function publishSupplementals(options) {
  return publishPackages({ ...options, managerIds: [] });
}
module.exports = { publishPackages, publishSupplementals, main };
