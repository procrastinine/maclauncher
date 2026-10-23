#!/usr/bin/env node
// Release-time only: no games, network requests or original binary mutations.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { isDeepStrictEqual } = require("node:util");
const B = require("../src/modules/shared/runtime/bundled-native");
const Native = require("../src/modules/shared/runtime/local-native");
const { validateSourceScope, validatePinnedSource, hashPinnedFiles } = require("../src/modules/shared/runtime/pinned-native-build");
const { createPinnedNativeManager } = require("../src/modules/shared/runtime/pinned-native-manager");
const Modules = require("../src/modules/registry");
const { requiresDistribution } = require("./distribution-model.cjs");

const REPO = path.resolve(__dirname, "..");
const systemLink = value => value.startsWith("/usr/lib/") || value.startsWith("/System/Library/");
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
const absolute = value => path.resolve(REPO, value);

function managers() {
  return new Map([...Modules.listModules().flatMap(info => Modules.getModule(info.id)?.runtimeManagers || []),
    ...Modules.listSharedRuntimeManagers()].map(manager => [manager.id, manager]));
}
// Candidate catalogs are an explicit maintainer API. They cannot replace a
// shipped pin, change runtime selections or relax normal package verification.
function resolveStagingPin(input, { arch = process.arch, stagingCatalog, managerCatalog = managers() } = {}) {
  const manager = managerCatalog.get(input.managerId);
  if (!manager) throw new Error(`Unknown runtime manager ${input.managerId}.`);
  if (stagingCatalog === undefined) {
    const pin = manager.core.catalog.find(entry => entry.version === input.version);
    if (!pin) throw new Error(`Unknown pinned runtime ${input.managerId} ${input.version}.`);
    return { manager, pin, candidate: false };
  }
  if (!stagingCatalog || stagingCatalog.schemaVersion !== 1 || !Array.isArray(stagingCatalog.managers) ||
      !stagingCatalog.managers.length || stagingCatalog.managers.length > 64) throw new Error("Staging catalog needs schema version 1 and explicit manager entries.");
  assertPublicMetadata(stagingCatalog);
  const seen = new Set(), candidates = new Map();
  for (const entry of stagingCatalog.managers) {
    const known = managerCatalog.get(entry?.id);
    if (!known || seen.has(entry.id) || !Array.isArray(entry.catalog) || !entry.catalog.length || entry.catalog.length > 64) {
      throw new Error("Staging catalog managers must be known, unique and have bounded pinned versions.");
    }
    seen.add(entry.id);
    if (!entry.distributionArchitectures) throw new Error("Staging catalog needs explicit host-to-artifact architecture mappings.");
    const targets = new Set();
    const mapping = entry.distributionArchitectures;
    for (const host of Object.keys(mapping)) {
      for (const target of require("./verify-native-runtimes.cjs").distributionArchitectures(entry, host)) targets.add(target);
    }
    if (!targets.size) throw new Error("Staging catalog needs supported artifact architectures.");
    for (const pin of entry.catalog) {
      additionalSourceIdentities(pin.additionalSources);
      validateSourceScope(pin.sourceScope);
      if (known.core.catalog.some(current => current.version === pin?.version)) throw new Error("Staging catalogs cannot override an existing runtime version.");
      if (!/^[a-f0-9]{40}$/.test(pin?.upstreamRevision || "") || !/^[a-f0-9]{64}$/.test(pin?.sourceTreeSha256 || "") ||
          !/^\d+\.\d+(?:\.\d+)?$/.test(pin?.minimumMacOS || "") || pin.asset || pin.publishedBinary || pin.localBuild === false ||
          !Array.isArray(pin.hostArchitectures) || !pin.hostArchitectures.length || pin.hostArchitectures.length > 2 ||
          new Set(pin.hostArchitectures).size !== pin.hostArchitectures.length ||
          pin.hostArchitectures.some(host => !["arm64", "x64"].includes(host) || !Object.hasOwn(mapping, host) || !mapping[host].length) ||
          pin.overlaySha256 !== undefined && !/^[a-f0-9]{64}$/.test(pin.overlaySha256 || "")) {
        throw new Error("Staging source pins need exact revision, source hash, macOS minimum and supported host architectures.");
      }
    }
    // The same safe-version, asset and duplicate validation used by installed
    // runtime catalogs applies before any candidate source or binary is read.
    const validated = createPinnedNativeManager({ id: entry.id, label: known.label || entry.id, catalog: entry.catalog });
    candidates.set(entry.id, { catalog: validated.core.catalog, targets });
  }
  const selected = candidates.get(input.managerId);
  const pin = selected?.catalog.find(entry => entry.version === input.version);
  if (!pin) throw new Error(`Staging catalog does not pin ${input.managerId} ${input.version}.`);
  if (!selected.targets.has(arch)) throw new Error(`Staging catalog has no ${arch} artifact for ${input.managerId}.`);
  return { manager, pin, candidate: true };
}

function validateCandidateSource(input, sourceRoot, source, pin) {
  if (input.provenance?.verifiedBuild !== true || !sourceRoot || !Array.isArray(source.files) ||
      input.provenance.sourceTreeSha256 !== pin.sourceTreeSha256 ||
      input.provenance.sourceRevision !== pin.upstreamRevision ||
      input.provenance.overlaySha256 !== pin.overlaySha256) throw new Error("Candidate source provenance differs from its staging pin.");
  if (hashPinnedFiles(sourceRoot, source.files) !== pin.sourceTreeSha256) throw new Error("Candidate source tree checksum differs from its staging pin.");
}

function additionalSourceIdentities(items = []) {
  if (!Array.isArray(items) || items.length > 16) throw new Error("Additional source identities must be a bounded list.");
  const seen = new Set();
  return items.map(item => {
    if (!item || Object.keys(item).some(key => !["id", "upstreamRevision", "sourceTreeSha256"].includes(key)) ||
        !/^[a-z0-9-]+$/.test(item.id || "") || seen.has(item.id) || !/^[a-f0-9]{40}$/.test(item.upstreamRevision || "") ||
        !/^[a-f0-9]{64}$/.test(item.sourceTreeSha256 || "")) throw new Error("Additional sources require unique IDs and exact revision/tree hashes.");
    seen.add(item.id); return { ...item };
  }).sort((a, b) => a.id.localeCompare(b.id));
}
async function validateAdditionalSources(input, pin, primaryRoot) {
  const expected = additionalSourceIdentities(pin.additionalSources), declared = input.additionalSources ?? [];
  if (!Array.isArray(declared) || declared.length > 16 || declared.some(item => !item ||
      Object.keys(item).some(key => !["id", "upstreamRevision", "sourceTreeSha256", "sourceRoot"].includes(key)) ||
      !path.isAbsolute(item.sourceRoot || ""))) throw new Error("Additional source roots require explicit absolute paths and identities.");
  const identities = additionalSourceIdentities(declared.map(({ sourceRoot, ...identity }) => identity));
  if (!isDeepStrictEqual(expected, identities) || !isDeepStrictEqual(expected, additionalSourceIdentities(input.provenance?.additionalSources))) {
    throw new Error("Additional source inputs and provenance differ from their catalog pin.");
  }
  if (!expected.length) return [];
  if (!primaryRoot || input.provenance?.verifiedBuild !== true) throw new Error("Additional sources require a verified source build.");
  const roots = [fs.realpathSync(primaryRoot)], jobs = [];
  for (const identity of expected) {
    const location = declared.find(item => item.id === identity.id).sourceRoot, stat = fs.lstatSync(location);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Additional source roots must be real directories.");
    const root = fs.realpathSync(location);
    if (roots.some(previous => root === previous || root.startsWith(previous + path.sep) || previous.startsWith(root + path.sep))) {
      throw new Error("Additional source roots must not overlap or duplicate other source inputs.");
    }
    roots.push(root); jobs.push({ identity, root });
  }
  await verifyAdditionalSources(jobs);
  return jobs;
}
async function verifyAdditionalSources(jobs) {
  for (const { identity, root } of jobs) {
    const source = await validatePinnedSource(root, identity.upstreamRevision);
    if (hashPinnedFiles(root, source.files) !== identity.sourceTreeSha256) throw new Error("Additional source tree checksum differs from its catalog pin.");
  }
}

function macho(file) {
  try { return Native.readMachOArchitectures(file, { allowLibrary: true }); } catch { return null; }
}

function loadCommands(file, architecture) {
  const text = run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-l", file]);
  const minima = [...text.matchAll(/cmd LC_BUILD_VERSION[^]*?minos\s+(\d+\.\d+(?:\.\d+)?)/g),
    ...text.matchAll(/cmd LC_VERSION_MIN_MACOSX[^]*?version\s+(\d+\.\d+(?:\.\d+)?)/g)].map(match => match[1]);
  if (!minima.length) throw new Error(`Missing macOS deployment target: ${file}`);
  const rpaths = [...text.matchAll(/cmd LC_RPATH\n[^]*?\n\s*path ([^\n]+) \(offset \d+\)/g)].map(match => match[1]);
  return { minimumMacOS: minima.sort((a, b) => B.versionAtLeast(a, b) ? -1 : 1)[0], rpaths };
}

function parseLinkedLibraries(output) {
  // Universal binaries have a separate unindented filename/architecture header
  // for each slice. Only indented compatibility records are dependency names.
  return [...new Set(String(output).split("\n").flatMap(line => {
    const match = /^\s+(.+?) \(compatibility version[^]*$/.exec(line);
    return match ? [match[1]] : [];
  }))];
}

function links(file, architecture) {
  return parseLinkedLibraries(run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-L", file]));
}

function libraryIds(file, architecture) {
  return run("/usr/bin/otool", [...(architecture ? ["-arch", architecture] : []), "-D", file]).split("\n").map(line => line.trim()).filter(line => line && !line.endsWith(":"));
}

function thinStagedMachO(target, payloadRoot, architecture, tool = run) {
  if (!["arm64", "x86_64"].includes(architecture)) throw new Error("Native thinning requires an explicit target CPU.");
  const root = fs.realpathSync(payloadRoot), file = path.resolve(target), relative = B.relativeFile(path.relative(root, file).split(path.sep).join("/"));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || !fs.realpathSync(file).startsWith(root + path.sep)) throw new Error("Native thinning requires a contained regular staging copy.");
  const architectures = macho(file);
  if (!architectures?.includes(architecture)) throw new Error("Native staging input has no selected CPU slice.");
  if (architectures.length === 1) return null;
  const beforeSha256 = Native.hashFile(file), temporary = path.join(path.dirname(file), `.thin-${crypto.randomUUID()}`);
  try {
    tool("/usr/bin/lipo", [file, "-thin", architecture, "-output", temporary]);
    if (!fs.lstatSync(temporary).isFile() || !isDeepStrictEqual(macho(temporary), [architecture]) || Native.hashFile(file) !== beforeSha256) throw new Error("Native slice extraction changed its input or produced a different CPU.");
    fs.chmodSync(temporary, stat.mode & 0o777);
    const afterSha256 = Native.hashFile(temporary), afterBytes = fs.statSync(temporary).size;
    fs.renameSync(temporary, file);
    return { file: relative, architecturesBefore: architectures, architecture, beforeSha256, beforeBytes: stat.size, afterSha256, afterBytes };
  } finally { fs.rmSync(temporary, { force: true }); }
}

function resolveLink(link, source, executable, inherited = [], architecture) {
  if (systemLink(link)) return null;
  const expand = value => value.replace(/^@loader_path(?=\/|$)/, path.dirname(source)).replace(/^@executable_path(?=\/|$)/, path.dirname(executable));
  const candidates = link.startsWith("@rpath/")
    ? [...loadCommands(source, architecture).rpaths, ...inherited].map(rpath => path.join(expand(rpath), link.slice(7)))
    : [expand(link)];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try { if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); } catch {}
  }
  throw new Error(`Unresolved non-system dependency '${link}' from ${source}. Add a complete framework/payload or fix its source build.`);
}

function copyTree(source, target, { excludes = [], rootExcludes = [], originalRoot = source, active = new Set() } = {}) {
  let resolved;
  try { resolved = fs.realpathSync(source); }
  catch (error) {
    // CMake app builds may retain an unused dylib alias for a renamed library.
    // Required load-command paths are checked separately and still fail closed.
    if (error.code === "ENOENT" && source.endsWith(".dylib") && fs.lstatSync(source).isSymbolicLink()) return;
    throw error;
  }
  const stat = fs.statSync(resolved);
  if (active.has(resolved)) throw new Error("Cyclic runtime payload symlink.");
  if (stat.isDirectory()) {
    if (resolved !== fs.realpathSync(originalRoot) && !resolved.startsWith(fs.realpathSync(originalRoot) + path.sep)) throw new Error("Runtime payload directory symlink escaped its root.");
    fs.mkdirSync(target, { recursive: true });
    const next = new Set([...active, resolved]);
    for (const name of fs.readdirSync(resolved)) {
      if ([".git", ".DS_Store", "__pycache__"].includes(name) || excludes.includes(name) ||
          resolved === fs.realpathSync(originalRoot) && rootExcludes.includes(name)) continue;
      copyTree(path.join(resolved, name), path.join(target, name), { excludes, rootExcludes, originalRoot, active: next });
    }
  } else if (stat.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(resolved, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, stat.mode & 0o777);
  } else throw new Error("Runtime payload contains a non-file entry.");
}

function applyPayloadPolicy(payload, { executableRelative, notices = [], runtimeFiles = {} }, policy) {
  if (!policy) return { runtimeFiles: { ...runtimeFiles }, removed: [] };
  if (Object.keys(policy).some(key => !["omitPaths", "omitRuntimeFiles"].includes(key)) ||
      !Array.isArray(policy.omitPaths) || policy.omitPaths.length > 64 ||
      policy.omitRuntimeFiles !== undefined && (!Array.isArray(policy.omitRuntimeFiles) ||
        policy.omitRuntimeFiles.some(key => typeof key !== "string" || !key))) throw new Error("Invalid native payload policy.");
  const omitted = policy.omitPaths.map(B.relativeFile), nextRuntimeFiles = { ...runtimeFiles };
  for (const key of policy.omitRuntimeFiles || []) delete nextRuntimeFiles[key];
  const matches = file => omitted.some(relative => file === relative || file.startsWith(relative + "/"));
  if ([executableRelative, ...notices.map(notice => notice.path), ...Object.values(nextRuntimeFiles)].some(matches)) {
    throw new Error("Native payload policy would remove a required executable, notice or runtime resource.");
  }
  const removed = B.fileInventory(payload).filter(matches);
  for (const relative of omitted) fs.rmSync(path.join(payload, relative), { recursive: true, force: true });
  return { runtimeFiles: nextRuntimeFiles, removed };
}

function formulaRoot(file) {
  const match = fs.realpathSync(file).match(/^(.*\/Cellar\/([^/]+)\/([^/]+))\//);
  return match ? { root: match[1], name: match[2], version: match[3] } : null;
}

function assertPublicMetadata(value) {
  if (typeof value === "string") {
    if (/\/(?:Users|home|Volumes|tmp|var\/folders|private\/(?:tmp|var))\/|(?:^|[\s"'=\\/])\.local[\\/]|[A-Za-z]:[\\/]Users[\\/]/.test(value) || value.includes(REPO + path.sep)) {
      throw new Error("Runtime metadata contains a private filesystem location. Provide logical source identities and build path mappings.");
    }
  } else if (Array.isArray(value)) {
    for (const item of value) assertPublicMetadata(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) { assertPublicMetadata(key); assertPublicMetadata(item); }
  }
  return value;
}

function publicProvenance(provenance, pathMappings = []) {
  if (!Array.isArray(pathMappings) || pathMappings.some(mapping => !mapping || !path.isAbsolute(mapping.from || "") ||
    typeof mapping.to !== "string" || !/^[A-Za-z0-9_${}.-]+$/.test(mapping.to))) throw new Error("Public provenance path mappings require absolute build prefixes and logical identities.");
  const mappings = [...pathMappings].sort((a, b) => b.from.length - a.from.length);
  function project(value) {
    if (typeof value === "string") return mappings.reduce((text, mapping) => text.split(mapping.from).join(mapping.to), value);
    if (Array.isArray(value)) return value.map(project);
    if (value && typeof value === "object") {
      const entries = [], keys = new Set();
      for (const [key, item] of Object.entries(value)) {
        if (["logPath", "evidenceSource"].includes(key)) continue;
        const projectedKey = project(key);
        if (keys.has(projectedKey)) throw new Error("Public provenance projection produces a duplicate metadata key.");
        keys.add(projectedKey); entries.push([projectedKey, project(item)]);
      }
      return Object.fromEntries(entries);
    }
    return value;
  }
  return assertPublicMetadata(project(provenance));
}

function sanitizeHomebrewReceipt(receipt, formula) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || !/^[A-Za-z0-9][A-Za-z0-9@+_.-]*$/.test(formula?.name || "") ||
    !/^[A-Za-z0-9][A-Za-z0-9+_.-]*$/.test(formula?.version || "")) throw new Error("A Homebrew receipt requires a public formula identity.");
  const sanitized = JSON.parse(JSON.stringify(receipt));
  if (!sanitized.source || typeof sanitized.source !== "object" || Array.isArray(sanitized.source)) throw new Error("Homebrew receipt source identity is missing.");
  delete sanitized.source.path;
  const tap = sanitized.source.tap || "homebrew/core";
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(tap)) throw new Error("Homebrew receipt tap identity is invalid.");
  sanitized.source.formula = `${tap}/${formula.name}`;
  sanitized.source.pkg_version = formula.version;
  return assertPublicMetadata(sanitized);
}

function addDependencyNotices(source, payload, notices, seen, receiptRoot) {
  const formula = formulaRoot(source);
  if (!formula || seen.has(formula.root)) return;
  if (notices.some(notice => notice.dependencyName === formula.name)) { seen.add(formula.root); return; }
  const candidates = fs.readdirSync(formula.root).filter(name => /^(?:licen[sc]e|copying|copyright|notice)(?:[._-].*)?$/i.test(name));
  if (!candidates.length) throw new Error(`Missing license notice for ${formula.name} ${formula.version}; add it explicitly to this package's notices.`);
  seen.add(formula.root);
  for (const name of candidates) {
    const relative = `licenses/dependencies/${formula.name}-${formula.version}/${name}`;
    copyTree(path.join(formula.root, name), path.join(payload, relative));
    notices.push({ name: `${formula.name} ${formula.version}`, license: "See included upstream license", sourceUrl: `https://github.com/Homebrew/homebrew-core/blob/HEAD/Formula/${formula.name[0]}/${formula.name}.rb`, path: relative });
  }
  const receipt = path.join(formula.root, "INSTALL_RECEIPT.json");
  if (fs.existsSync(receipt)) {
    const bytes = fs.readFileSync(receipt), directory = `${formula.name}-${formula.version}`;
    const privateDirectory = path.join(receiptRoot, "dependencies", B.relativeFile(directory));
    fs.mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(privateDirectory, "INSTALL_RECEIPT.json"), bytes, { flag: "wx", mode: 0o600 });
    const sanitized = sanitizeHomebrewReceipt(JSON.parse(bytes), formula);
    fs.writeFileSync(path.join(payload, `licenses/dependencies/${directory}/INSTALL_RECEIPT.json`), JSON.stringify(sanitized, null, 2) + "\n", { flag: "wx", mode: 0o644 });
  }
}
function reviewedBinaryTree(root) {
  const files = B.fileInventory(root).map(relative => {
    const file = path.join(root, relative), stat = fs.lstatSync(file);
    return { path: relative, size: stat.size, mode: stat.mode & 0o777, sha256: Native.hashFile(file) };
  });
  return B.digest(Buffer.from(JSON.stringify(files)));
}

async function validateArtifactSource(input, sourceRoot, revision, pin) {
  const scope = validateSourceScope(pin?.sourceScope);
  if (scope) {
    if (input.provenance?.verifiedBuild !== true ||
        ["reviewed-binary", "official-release"].includes(input.provenance?.sourceKind) ||
        !isDeepStrictEqual(input.provenance?.sourceScope, pin.sourceScope) ||
        input.provenance?.sourceRevision !== revision || input.provenance?.sourceTreeSha256 !== pin.sourceTreeSha256 ||
        !/^[a-f0-9]{64}$/.test(pin.sourceTreeSha256 || "")) throw new Error("Primary source scope and verified-build provenance must match the catalog pin.");
    const source = await validatePinnedSource(sourceRoot, revision, { sourceScope: scope });
    if (hashPinnedFiles(sourceRoot, source.files) !== pin.sourceTreeSha256) throw new Error("Pinned primary source tree checksum changed.");
    if (input.provenance.omittedSubmodules !== undefined && !isDeepStrictEqual(input.provenance.omittedSubmodules, source.omittedSubmodules)) {
      throw new Error("Omitted submodule descriptors differ from the pinned primary Git tree.");
    }
    return source;
  }
  if (input.provenance?.sourceScope !== undefined || input.provenance?.omittedSubmodules !== undefined) {
    throw new Error("Source omissions require an explicit matching catalog scope.");
  }
  if (input.provenance?.sourceKind === "reviewed-binary") {
    const identity = pin?.publishedBinary;
    if (input.provenance.verifiedBuild !== false || sourceRoot || !input.appRoot ||
        !/^[a-f0-9]{40}$/.test(revision || "") ||
        !/^[a-f0-9]{64}$/.test(identity?.executableSha256 || "") ||
        !/^[a-f0-9]{64}$/.test(identity?.treeSha256 || "") ||
        input.expectedInputSha256 !== identity.executableSha256 ||
        Native.hashFile(absolute(input.executable)) !== identity.executableSha256 ||
        reviewedBinaryTree(absolute(input.appRoot)) !== identity.treeSha256) {
      throw new Error("Reviewed binary input must match its catalog's complete artifact identity; no source checkout or verified-build claim is permitted.");
    }
    return { head: revision, artifactTreeSha256: identity.treeSha256 };
  }
  if (input.provenance?.sourceKind !== "official-release") return validatePinnedSource(sourceRoot, revision);
  const provenance = input.provenance;
  if (provenance.verifiedBuild !== false || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\//.test(provenance.assetUrl || "") ||
    !/^[a-f0-9]{64}$/.test(provenance.archiveSha256 || "") || !Number.isSafeInteger(provenance.assetId) || provenance.assetId < 1 ||
    typeof provenance.releaseTag !== "string" || !provenance.releaseTag || provenance.releaseTag.length > 200 || !/^[a-f0-9]{40}$/.test(revision || "")) {
    throw new Error("Official-release provenance needs a publisher artifact identity and cannot claim a verified source build.");
  }
  const head = run("git", ["-c", "core.fsmonitor=false", "-C", sourceRoot, "rev-parse", "HEAD"]).trim();
  if (head !== revision) throw new Error("Official-release source tag differs from its catalog revision.");
  if (run("git", ["-c", "core.fsmonitor=false", "-C", sourceRoot, "status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=all"]).trim()) throw new Error("Official-release source checkout has tracked changes.");
  // The published binary is identified independently. Unused source submodules
  // neither establish its build provenance nor need initializing to copy it.
  return { head };
}

async function stagePackage(input, { outputRoot, maximumMacOS = "13.0", signingIdentity = "-", arch = process.arch, tool = run, stagingCatalog } = {}) {
  if (process.platform !== "darwin") throw new Error("Native runtime distribution staging requires macOS.");
  if (!["arm64", "x64"].includes(arch)) throw new Error("Choose an explicit arm64 or x64 distribution architecture.");
  if (input.executableMode !== undefined && input.executableMode !== 0o755) throw new Error("The staged executable mode must be 0755.");
  if (input.thinToTargetArchitecture !== undefined && typeof input.thinToTargetArchitecture !== "boolean" || input.provenance?.nativeThinning !== undefined) throw new Error("Native thinning must be an explicit boolean staging option; its provenance is generated by the stager.");
  const selectedCPU = input.thinToTargetArchitecture ? arch === "x64" ? "x86_64" : arch : undefined;
  const { manager, pin, candidate } = resolveStagingPin(input, { arch, stagingCatalog });
  const sourceRoot = input.provenance?.sourceKind === "reviewed-binary" && !input.sourceRoot ? null : absolute(input.sourceRoot);
  const executable = fs.realpathSync(absolute(input.executable));
  const source = await validateArtifactSource(input, sourceRoot, pin.upstreamRevision, pin);
  if (candidate) validateCandidateSource(input, sourceRoot, source, pin);
  const additionalSources = await validateAdditionalSources(input, pin, sourceRoot);
  const inputHash = Native.hashFile(executable);
  if (!/^[a-f0-9]{64}$/.test(input.expectedInputSha256 || "") || inputHash !== input.expectedInputSha256) throw new Error(`Input executable checksum differs from the reviewed build: ${input.managerId}`);
  if (!Array.isArray(input.notices) || !input.notices.length) throw new Error("Every runtime package needs upstream and dependency license notices.");
  const root = absolute(outputRoot), destination = path.join(root, input.managerId, pin.version, arch);
  B.realDirectory(path.dirname(destination), { create: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), ".stage-")), payload = path.join(staging, "files");
  const originals = new Map(), sourceTargets = new Map(), binarySources = new Map();
  try {
    const provenance = publicProvenance({ sourceRevision: source.head, inputExecutableSha256: inputHash,
      ...(source.artifactTreeSha256 ? { inputArtifactTreeSha256: source.artifactTreeSha256 } : {}),
      verifiedBuild: input.provenance?.verifiedBuild === true, ...input.provenance,
      ...(source.sourceScope ? { sourceScope: source.sourceScope, omittedSubmodules: source.omittedSubmodules } : {}) }, input.provenancePathMappings);
    const receiptRoot = path.join(root, ".build-records", input.managerId, input.version, arch, crypto.randomUUID());
    B.realDirectory(receiptRoot, { create: true });
    fs.writeFileSync(path.join(receiptRoot, "artifact-input.json"), JSON.stringify({ input, arch, maximumMacOS,
      signingIdentity, sourceRevision: source.head, inputExecutableSha256: inputHash, stagedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const executableRelative = resolveExecutableRelative(input, executable);
    if (input.appRoot) {
      const rootExcludes = input.appRootNoticeFiles || [];
      if (!Array.isArray(rootExcludes) || rootExcludes.some(name => typeof name !== "string" ||
          path.basename(name) !== name || [".", "..", "Contents"].includes(name) ||
          !input.notices.some(notice => absolute(notice.file) === path.join(absolute(input.appRoot), name)))) {
        throw new Error("App-root notice files must be explicitly preserved in the package's license inventory.");
      }
      // Modern codesign rejects extra license files beside Contents. Preserve
      // those exact notices in licenses/, leaving the copied app root sealable.
      copyTree(absolute(input.appRoot), path.join(payload, path.basename(input.appRoot)), { rootExcludes });
    }
    else copyTree(executable, path.join(payload, executableRelative));
    if (input.executableMode !== undefined) fs.chmodSync(path.join(payload, executableRelative), input.executableMode);
    for (const extra of input.payloads || []) copyTree(absolute(extra.source), path.join(payload, B.relativeFile(extra.relative)), { excludes: extra.excludes || [] });
    const notices = [];
    for (const [index, notice] of input.notices.entries()) {
      const relative = `licenses/upstream/${index}-${path.basename(notice.file)}`;
      copyTree(absolute(notice.file), path.join(payload, relative));
      notices.push({ name: notice.name, license: notice.license, sourceUrl: notice.sourceUrl, path: relative,
        ...(notice.dependencyName ? { dependencyName: notice.dependencyName } : {}) });
    }
    const payloadContent = applyPayloadPolicy(payload, { executableRelative, notices, runtimeFiles: input.runtimeFiles || {} }, manager.payloadPolicy);
    // Match initial copied Mach-O files to their originals, including app plugins.
    const originalPayloads = [{ source: input.appRoot ? absolute(input.appRoot) : executable,
      relative: input.appRoot ? path.basename(input.appRoot) : executableRelative }, ...(input.payloads || []).map(item => ({ source: absolute(item.source), relative: item.relative }))];
    for (const relative of B.fileInventory(payload)) {
      const target = path.join(payload, relative);
      if (!macho(target)) continue;
      const entry = originalPayloads.find(item => relative === item.relative || relative.startsWith(item.relative + "/"));
      const original = fs.realpathSync(relative === entry.relative ? entry.source : path.join(entry.source, relative.slice(entry.relative.length + 1)));
      sourceTargets.set(original, target); binarySources.set(target, original); originals.set(original, Native.hashFile(original));
    }
    const noticeRoots = new Set(), inherited = loadCommands(executable, selectedCPU).rpaths, thinned = [];
    const extraLibraries = [...(input.extraLibraries || [])];
    // SDL2-compat's SDL3 is loaded with dlopen and is absent from otool -L.
    if ([...binarySources.values()].some(file => file.includes("sdl2-compat"))) {
      const sdl3 = input.sdl3Library || "/opt/homebrew/opt/sdl3/lib/libSDL3.dylib";
      if (!fs.existsSync(absolute(sdl3))) throw new Error("SDL2-compat needs an explicit bundled SDL3 companion library.");
      extraLibraries.push(sdl3);
    }
    function copyLibrary(source) {
      const original = fs.realpathSync(absolute(source));
      if (sourceTargets.has(original)) return sourceTargets.get(original);
      const target = path.join(payload, "lib", path.basename(source));
      if (fs.existsSync(target) && Native.hashFile(target) !== Native.hashFile(original)) throw new Error(`Conflicting native library basenames: ${path.basename(source)}`);
      if (!fs.existsSync(target)) copyTree(original, target);
      sourceTargets.set(original, target); binarySources.set(target, original); originals.set(original, Native.hashFile(original));
      return target;
    }
    for (const extra of extraLibraries) copyLibrary(absolute(extra));
    const queue = [...binarySources.keys()], processed = new Set();
    for (let index = 0; index < queue.length; index++) {
      const target = queue[index], original = binarySources.get(target);
      if (processed.has(target)) continue;
      processed.add(target);
      if (selectedCPU) {
        const transformation = thinStagedMachO(target, payload, selectedCPU, tool);
        if (transformation) thinned.push(transformation);
      }
      addDependencyNotices(original, payload, notices, noticeRoots, receiptRoot);
      const originalCommands = loadCommands(original, selectedCPU);
      for (const link of links(original, selectedCPU)) {
        if (systemLink(link)) continue;
        if (libraryIds(original, selectedCPU).includes(link)) continue;
        const dependency = resolveLink(link, original, executable, [...originalCommands.rpaths, ...inherited], selectedCPU);
        if (dependency === original) continue; // a dylib's LC_ID_DYLIB
        const dependencyTarget = copyLibrary(dependency);
        const relocated = `@loader_path/${path.relative(path.dirname(target), dependencyTarget).split(path.sep).join("/")}`;
        tool("/usr/bin/install_name_tool", ["-change", link, relocated, target]);
        queue.push(dependencyTarget);
        if (dependency.includes("sdl2-compat")) {
          const sdl3 = copyLibrary(absolute(input.sdl3Library || "/opt/homebrew/opt/sdl3/lib/libSDL3.dylib"));
          queue.push(sdl3);
        }
      }
      for (const rpath of originalCommands.rpaths.filter(value => value.startsWith("/") && !systemLink(value))) tool("/usr/bin/install_name_tool", ["-delete_rpath", rpath, target]);
      if (libraryIds(target).length) tool("/usr/bin/install_name_tool", ["-id", `@rpath/${path.basename(target)}`, target]);
    }
    // SDL3's loader searches alongside SDL2-compat, so keep its expected basename.
    if ([...binarySources.values()].some(file => file.includes("sdl2-compat")) && !fs.existsSync(path.join(payload, "lib", "libSDL3.dylib"))) throw new Error("SDL2-compat's libSDL3.dylib was not included beside it.");
    let minimumMacOS = "0.0";
    for (const target of processed) {
      const architectures = macho(target), commands = loadCommands(target);
      if (!architectures?.includes(arch === "x64" ? "x86_64" : arch)) throw new Error(`Dependency architecture differs from ${arch}: ${target}`);
      if (B.versionAtLeast(commands.minimumMacOS, minimumMacOS)) minimumMacOS = commands.minimumMacOS;
    }
    if (!B.versionAtLeast(maximumMacOS, minimumMacOS)) throw new Error(`${input.managerId} dependency closure requires macOS ${minimumMacOS}, above distribution target ${maximumMacOS}. Rebuild the executable and dependencies for the selected target.`);
    if (candidate && (!B.versionAtLeast(pin.minimumMacOS, minimumMacOS) || !B.versionAtLeast(minimumMacOS, pin.minimumMacOS))) {
      throw new Error("Candidate dependency closure has a different macOS minimum from its staging pin.");
    }
    for (const target of processed) tool("/usr/bin/codesign", ["--force", "--sign", signingIdentity, ...(signingIdentity === "-" ? ["--timestamp=none"] : ["--timestamp"]), target]);
    if (input.appRoot) tool("/usr/bin/codesign", ["--force", "--sign", signingIdentity, ...(signingIdentity === "-" ? ["--timestamp=none"] : ["--timestamp"]), path.join(payload, path.basename(input.appRoot))]);
    for (const target of processed) tool("/usr/bin/codesign", ["--verify", "--strict", target]);
    const dependencies = [...processed].map(target => ({ file: path.relative(payload, target).split(path.sep).join("/"),
      links: links(target).filter(link => !libraryIds(target).includes(link)) }));
    const files = B.fileInventory(payload).map(relative => {
      const target = path.join(payload, relative), stat = fs.statSync(target), architectures = macho(target);
      return { path: relative, size: stat.size, sha256: Native.hashFile(target), mode: stat.mode & 0o777,
        ...(architectures ? { architectures } : {}) };
    });
    if (selectedCPU) provenance.nativeThinning = { version: "mach-o-slice-v1", architecture: selectedCPU, files: thinned.sort((a, b) => a.file.localeCompare(b.file)) };
    const manifest = { schemaVersion: 1, managerId: input.managerId, version: input.version, upstreamRevision: source.head,
      platform: "darwin", arch, minimumMacOS, executableRelative, files, dependencies, notices,
      environmentRelative: input.environmentRelative || {}, runtimeFiles: payloadContent.runtimeFiles, signature: { identity: signingIdentity, verified: true },
      provenance, createdAt: new Date().toISOString() };
    B.validateManifest(manifest, { managerId: input.managerId, version: input.version, upstreamRevision: pin.upstreamRevision, arch });
    B.verifyPayload(payload, manifest);
    await verifyAdditionalSources(additionalSources);
    if (candidate || pin.sourceScope) {
      const currentSource = await validateArtifactSource(input, sourceRoot, pin.upstreamRevision, pin);
      if (candidate) validateCandidateSource(input, sourceRoot, currentSource, pin);
    }
    for (const [file, expected] of originals) if (Native.hashFile(file) !== expected) throw new Error("An original artifact or dependency changed during staging.");
    fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    fs.writeFileSync(path.join(receiptRoot, "public-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const previous = `${destination}.previous-${crypto.randomUUID()}`;
    if (fs.existsSync(destination)) fs.renameSync(destination, previous);
    try { fs.renameSync(staging, destination); } catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, destination); throw error; }
    fs.rmSync(previous, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return { managerId: input.managerId, version: input.version, directory: destination, minimumMacOS,
      files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
  } finally { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

function resolveExecutableRelative(input, executable) {
  const detected = input.appRoot
    ? `${path.basename(input.appRoot)}/${path.relative(absolute(input.appRoot), executable).split(path.sep).join("/")}`
    : `bin/${path.basename(executable)}`;
  if (input.appRoot && input.executableRelative !== undefined && input.executableRelative !== detected) throw new Error("App-bundle executable location cannot be overridden.");
  return B.relativeFile(input.executableRelative === undefined ? detected : input.executableRelative);
}

async function main(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index].startsWith("--") || !args[index + 1]) throw new Error("Usage: node scripts/stage-native-runtimes.cjs --config <JSON> --output <directory> [--maximum-macos 13.0] [--sign-identity <identity>] [--arch arm64|x64] [--only id,id]");
    options[args[index].slice(2)] = args[index + 1];
  }
  if (!options.config) throw new Error("An explicit artifact inventory JSON is required; see docs/runtimes/RUNTIME_DISTRIBUTION.md.");
  const config = JSON.parse(fs.readFileSync(absolute(options.config), "utf8"));
  const selected = options.only?.split(","), packages = config.packages?.filter(input => !selected || selected.includes(input.managerId));
  if (!packages?.length || selected?.some(id => !packages.some(input => input.managerId === id))) throw new Error("Selected runtime artifact inventory is incomplete.");
  const required = selected || [...managers().values()].filter(requiresDistribution).map(manager => manager.id);
  if (required.some(id => !packages.some(input => input.managerId === id))) throw new Error(`Missing required runtime artifacts: ${required.filter(id => !packages.some(input => input.managerId === id)).join(", ")}. Provide builds or use an explicit --only partial profile.`);
  if (!options.output) throw new Error("An explicit --output directory is required.");
  const outputRoot = options.output;
  for (const input of packages) console.log(JSON.stringify(await stagePackage(input, { outputRoot, maximumMacOS: options["maximum-macos"] || "13.0", signingIdentity: options["sign-identity"] || "-", arch: options.arch || process.arch })));
}

module.exports = { stagePackage, applyPayloadPolicy, resolveStagingPin, validateCandidateSource, additionalSourceIdentities, validateAdditionalSources, verifyAdditionalSources, validateArtifactSource, reviewedBinaryTree, requiresDistribution, resolveExecutableRelative, thinStagedMachO, loadCommands, parseLinkedLibraries, links, libraryIds, resolveLink, copyTree, managers, main, publicProvenance, sanitizeHomebrewReceipt };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
