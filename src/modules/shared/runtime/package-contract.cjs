// Shared public contracts for the launcher and native package producer.
const B = require("./bundled-native");
const SHA256 = /^[a-f0-9]{64}$/;
const SHA = SHA256, FLOOR = /^\d{1,2}\.\d{1,2}(?:\.\d{1,2})?$/;
const ARCHITECTURES = new Set(["arm64", "x64", "universal"]);
const LAUNCHER_ARCHITECTURES = new Set(["arm64", "x64"]);
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const RECORD_KEYS = ["schemaVersion","id","version","arch","launcherArchitectures","minimumMacOS","manifestRelative","manifestSha256","sourceSha256","updatePolicy","tag","asset","sourceAsset","source","launcherContract","capabilities"];
const ARCHITECTURE_NAME = /^[a-z][a-z0-9_]{0,31}$/, CAPABILITY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function checksum(value) {
  return typeof value === "string" && SHA256.test(value);
}

function identity({ projectId, repository } = {}) {
  if (typeof projectId !== "string" || projectId.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(projectId))
    throw new Error("A runtime catalog requires a valid project ID.");
  if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) ||
      repository.includes("..") || repository.split("/").some(part => part.endsWith(".")))
    throw new Error("A runtime catalog requires an explicit GitHub owner/repository.");
  return { projectId, repository };
}

function version(value) {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    !value.includes("..") && !value.endsWith(".") && !value.endsWith(".lock");
}

function relativeFile(value) {
  return typeof value === "string" && value.length <= 1024 && value.split("/").every(part =>
    part !== "." && part !== ".." && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part));
}

function contract(value) {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("The runtime launcher contract is invalid.");
  return value;
}

function sourceMetadata(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).some(key => !["repository", "revision", "path"].includes(key)) ||
      !/^[a-f0-9]{40}$/.test(value.revision || "") || value.path !== undefined && !relativeFile(value.path))
    throw new Error("The runtime source must identify a pinned source commit.");
  identity({ projectId: "source", repository: value.repository });
  return Object.freeze({ repository: value.repository, revision: value.revision,
    ...(value.path === undefined ? {} : { path: value.path }) });
}

// A CPU name this launcher does not know belongs to a later launcher.
function laterArchitecture(value) {
  return typeof value === "string" && ARCHITECTURE_NAME.test(value) && !ARCHITECTURES.has(value);
}

// Facts that modules read to match a game and runtime. Each module checks the
// values it reads; this contract only bounds the shape and size.
function capabilities(value) {
  const plain = (item, depth) => item === null || ["string", "number", "boolean"].includes(typeof item) || depth < 3 &&
    (Array.isArray(item) ? item.every(entry => plain(entry, depth + 1)) : object(item) && Object.values(item).every(entry => plain(entry, depth + 1)));
  if (!object(value) || Object.keys(value).length > 64 || Object.keys(value).some(key => !CAPABILITY_NAME.test(key)) ||
      !plain(value, 0) || JSON.stringify(value).length > 8192)
    throw new Error("The runtime catalog contains invalid capabilities.");
  return Object.freeze(JSON.parse(JSON.stringify(value)));
}

function compatibilityMetadata(record) {
  if (!object(record)) throw new Error("Invalid runtime compatibility metadata.");
  return Object.freeze({
    ...(record.launcherContract === undefined ? {} : { launcherContract: contract(record.launcherContract) }),
    ...(record.capabilities === undefined ? {} : { capabilities: capabilities(record.capabilities) })
  });
}

function validatePublicMetadata(value) {
  if (typeof value === "string") {
    if (/\/(?:Users|home|Volumes|tmp|var\/folders|private\/(?:tmp|var))\/|(?:^|[\s"'=\\/])\.local[\\/]|[A-Za-z]:[\\/]Users[\\/]|file:\/\//i.test(value))
      throw new Error("Package metadata contains private filesystem paths.");
  } else if (Array.isArray(value)) {
    for (const item of value) validatePublicMetadata(item);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:password|accessToken|refreshToken|logPath|evidenceSource)$/i.test(key))
        throw new Error("Sealed native metadata contains private diagnostic fields.");
      validatePublicMetadata(key); validatePublicMetadata(item);
    }
  }
  return value;
}

function validateSourceArtifact(item) {
  if (!object(item) || Object.keys(item).some(key => !["managerId", "version", "directoryRelative", "sha256", "bytes"].includes(key)) ||
      !/^[a-z0-9-]+$/.test(item.managerId || "") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.version || "") ||
      !SHA.test(item.sha256 || "") || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > B.LIMITS.fileBytes ||
      B.relativeFile(item.directoryRelative) !== item.directoryRelative || item.directoryRelative !== item.managerId + "/" + item.version + "-source.tar.gz")
    throw new Error("Invalid corresponding-source archive identity.");
  return validatePublicMetadata(item);
}

function packageRecord(record, { projectId, repository, launcherContract = 1, publication = false, requireUrl = true }) {
  if (!object(record) || !version(record.version)) throw new Error("The runtime catalog contains an invalid package record.");
  if (!publication && (Number.isSafeInteger(record.schemaVersion) && record.schemaVersion > 2 || contract(record.launcherContract) > launcherContract ||
      laterArchitecture(record.arch) || Array.isArray(record.launcherArchitectures) && record.launcherArchitectures.some(laterArchitecture)))
    throw new Error("Requires a newer MacLauncher.");
  if (publication) {
    if (Object.keys(record).some(key => !RECORD_KEYS.includes(key)) ||
        record.asset && Object.keys(record.asset).some(key => !["filename", "sha256", "bytes", "url"].includes(key)) ||
        record.sourceAsset && Object.keys(record.sourceAsset).some(key => !["filename", "sha256", "bytes", "url"].includes(key)))
      throw new Error("Invalid runtime release record.");
    validatePublicMetadata(record);
  }
  if (record.schemaVersion !== 2 || record.id !== projectId || record.updatePolicy !== "manual" ||
      !version(record.version) || !ARCHITECTURES.has(record.arch) ||
      !Array.isArray(record.launcherArchitectures) || record.launcherArchitectures.length < 1 ||
      Array.from(record.launcherArchitectures).some(arch => !LAUNCHER_ARCHITECTURES.has(arch)) ||
      new Set(record.launcherArchitectures).size !== record.launcherArchitectures.length ||
      typeof record.minimumMacOS !== "string" || !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(record.minimumMacOS) ||
      Number(record.minimumMacOS.split(".")[0]) < 1 || !relativeFile(record.manifestRelative) ||
      !checksum(record.manifestSha256) || !checksum(record.sourceSha256) || !object(record.asset))
    throw new Error("The runtime catalog contains an invalid package record.");

  const tag = `${projectId}/v${record.version}/${record.arch}`;
  const filename = `${projectId}-${record.version}-${record.arch}.tar.gz`;
  const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${filename}`;
  if ((requireUrl || record.tag !== undefined) && record.tag !== tag)
    throw new Error("The runtime download tag does not match its project, version, architecture or repository.");
  if ((requireUrl || record.asset.url !== undefined) && record.asset.url !== url)
    throw new Error("The runtime download URL does not match its project, version, architecture or repository.");
  if (record.asset.filename !== filename ||
      !checksum(record.asset.sha256) || !Number.isSafeInteger(record.asset.bytes) ||
      record.asset.bytes < 1 || record.asset.bytes > MAX_ARCHIVE_BYTES)
    throw new Error("The runtime download does not match its project, version, architecture or repository.");

  let sourceAsset;
  if (record.sourceAsset !== undefined) {
    const source = record.sourceAsset;
    if (!object(source) || source.filename !== `${record.version}-source.tar.gz` ||
        !source.filename.endsWith("-source.tar.gz") || !checksum(source.sha256) ||
        !Number.isSafeInteger(source.bytes) || source.bytes < 1 || source.bytes > MAX_ARCHIVE_BYTES ||
        source.url !== `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${source.filename}`)
      throw new Error("The runtime source download does not match its release.");
    sourceAsset = Object.freeze({ filename: source.filename, url: source.url, sha256: source.sha256, bytes: source.bytes });
  }
  const source = sourceMetadata(record.source);
  const compatibility = compatibilityMetadata(record);
  return Object.freeze({ schemaVersion: 2, id: projectId, version: record.version, arch: record.arch,
    launcherArchitectures: Object.freeze([...record.launcherArchitectures]), minimumMacOS: record.minimumMacOS,
    manifestRelative: record.manifestRelative, manifestSha256: record.manifestSha256,
    sourceSha256: record.sourceSha256, updatePolicy: "manual", tag,
    asset: Object.freeze({ filename, sha256: record.asset.sha256, bytes: record.asset.bytes, url }),
    ...(sourceAsset ? { sourceAsset } : {}), ...(source ? { source } : {}),
    ...(record.launcherContract === undefined ? {} : { launcherContract: record.launcherContract }), ...compatibility });
}

function validateDeclaration(item) {
  const keys = ['id', 'version', 'arch', 'launcherArchitectures', 'minimumMacOS', 'sourceRelative', 'sourceSha256', 'sourceArtifact', 'directoryRelative', 'manifestRelative', 'manifestSha256', 'files', 'notices', 'redistribution'];
  if (!item || Object.keys(item).some(key => !keys.includes(key)) || !/^[a-z0-9-]+$/.test(item.id || '') ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.version || '') || !['arm64', 'x64', 'universal'].includes(item.arch) ||
    !FLOOR.test(item.minimumMacOS || '') || !SHA.test(item.sourceSha256 || '') || !SHA.test(item.manifestSha256 || '') ||
    !Array.isArray(item.launcherArchitectures) || !item.launcherArchitectures.length || new Set(item.launcherArchitectures).size !== item.launcherArchitectures.length ||
    item.launcherArchitectures.some(arch => !['arm64', 'x64'].includes(arch)) ||
    item.directoryRelative !== `${item.id}/${item.version}/${item.arch}` || !Array.isArray(item.files) || !item.files.length || item.files.length > B.LIMITS.files ||
      !Array.isArray(item.notices) || !item.notices.length ||
      item.redistribution !== undefined && !['bundle', 'local-only'].includes(item.redistribution)) throw new Error('Invalid supplemental native declaration.');
  const names = new Set(); let bytes = 0;
  for (const file of item.files) {
    if (!file || Object.keys(file).some(key => !['path', 'size', 'mode', 'sha256', 'architectures', 'format', 'executionArchitecture', 'optionalLoad'].includes(key)) ||
      B.relativeFile(file.path) !== file.path || names.has(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > B.LIMITS.fileBytes ||
      ![0o640, 0o644, 0o755].includes(file.mode) || !SHA.test(file.sha256 || '')) throw new Error('Invalid sealed supplemental native file.');
    if (file.format !== undefined && (!['mach-o', 'pe'].includes(file.format) || !file.architectures)) throw new Error('Invalid supplemental file format.');
    if (file.architectures && (!Array.isArray(file.architectures) || !file.architectures.length || new Set(file.architectures).size !== file.architectures.length ||
      file.architectures.some(arch => !(file.format === 'pe' ? ['arm64', 'x86_64', 'x86'] : ['arm64', 'x86_64']).includes(arch)))) throw new Error('Invalid supplemental native architectures.');
    if (Object.hasOwn(file, 'optionalLoad')) {
      const optional = file.optionalLoad;
      if (!optional || typeof optional !== 'object' || Array.isArray(optional) || Object.keys(optional).some(key => !['architectures', 'minimumMacOS'].includes(key)) ||
        file.format === 'pe' || !file.architectures || Object.hasOwn(file, 'executionArchitecture') || !FLOOR.test(optional.minimumMacOS || '') ||
        !B.versionAtLeast(optional.minimumMacOS, item.minimumMacOS) || !Array.isArray(optional.architectures) || !optional.architectures.length ||
        new Set(optional.architectures).size !== optional.architectures.length || optional.architectures.some(arch => !['arm64', 'x86_64'].includes(arch) || !file.architectures.includes(arch)))
        throw new Error('Optional native loading requires actual CPU slices and an explicit compatible macOS floor.');
    }
    // An explicitly Intel child can run under Rosetta in an ARM launcher. This
    // does not change the library's actual slices or make it loadable in an ARM
    // process; the module must select the Intel host and request Rosetta.
    if (Object.hasOwn(file, 'executionArchitecture')) {
      if (file.format === 'pe' || file.executionArchitecture !== 'x86_64' || !file.architectures?.includes('x86_64')) {
        throw new Error('Supplemental execution architecture requires a genuine Intel native file.');
      }
    } else if (file.format !== 'pe' && !file.optionalLoad && file.architectures && item.launcherArchitectures.some(arch =>
      !file.architectures.includes(arch === 'x64' ? 'x86_64' : arch))) {
      throw new Error('Supplemental native architecture does not cover its launcher CPUs.');
    }
    names.add(file.path); bytes += file.size;
  }
  if (item.sourceArtifact !== undefined) {
    const source = validateSourceArtifact({ managerId: item.id, version: item.version, ...item.sourceArtifact });
    if (source.managerId !== item.id || source.version !== item.version) throw new Error('Supplemental corresponding source must match its package identity.');
  }
  if (bytes > B.LIMITS.bytes || (item.files.some(file => file.optionalLoad) && !item.files.some(file => file.architectures && !file.optionalLoad)) ||
    (!item.sourceArtifact && item.sourceRelative === undefined) ||
    item.sourceRelative != null && !item.files.some(file => file.path === item.sourceRelative && file.sha256 === item.sourceSha256) ||
    !item.files.some(file => file.path === item.manifestRelative && file.sha256 === item.manifestSha256)) throw new Error('Supplemental native source, manifest or dependency inventory is incomplete.');
  for (const notice of item.notices) {
    if (!notice || Object.keys(notice).some(key => !['name', 'license', 'path', 'sourceUrl'].includes(key)) ||
      typeof notice.name !== 'string' || !notice.name.trim() || typeof notice.license !== 'string' || !notice.license.trim() || !names.has(notice.path)) throw new Error('Supplemental native license notice is missing.');
    if (notice.sourceUrl && !/^https:\/\//.test(notice.sourceUrl)) throw new Error('Supplemental source links must use HTTPS.');
  }
  validatePublicMetadata(item);
  return item;
}

module.exports = { packageRecord, compatibilityMetadata, sourceMetadata, validatePublicMetadata, validateSourceArtifact, validateDeclaration, object, checksum, identity, version, relativeFile, contract };
