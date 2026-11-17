const fs = require("node:fs"), path = require("node:path");
const { createPinnedNativeManager } = require("../../../shared/runtime/pinned-native-manager");
const Native = require("../../../shared/runtime/local-native");
const Binary = require("../../../../core/binary-arch");
const Architecture = require("../../../shared/runtime/architecture");
const Zip = require("../../../shared/runtime/zip");
const Bundle = require("../../../shared/runtime/bundled-native");
const { throwIfAborted } = require("../../../shared/runtime/download-utils");
const { createSource, BASE } = require("./catalog");
const { managerDefaultVersion } = require("../../../shared/runtime/version-choices");
const LIBRARY = "libsteamworks4j.dylib";

function architectures(file) {
  const fd = fs.openSync(file, "r");
  let known;
  try {
    const head = Buffer.alloc(4), size = fs.fstatSync(fd).size;
    known = size >= 4 && fs.readSync(fd, head, 0, 4, 0) === 4 && Binary.machoMagic(head.readUInt32BE(0));
  } finally { fs.closeSync(fd); }
  if (!known) return [];
  try { return Native.readMachOArchitectures(file, { allowLibrary: true }); }
  catch (error) {
    if (error.message === "Runtime uses an unsupported macOS CPU architecture.") return [];
    throw error;
  }
}
function findLibraries(root, depth = 0) {
  if (depth > 6) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? findLibraries(file, depth + 1) : entry.isFile() && entry.name === LIBRARY ? [file] : [];
  });
}
function libraryPath(root, architecture = Architecture.selectedArchitecture()) {
  if (fs.statSync(root).isFile()) return root;
  const files = findLibraries(root), cpu = architecture === "x64" ? "x86_64" : architecture;
  const measured = files.map(file => ({ file, cpus: architectures(file) }));
  const selected = measured.find(item => item.cpus.includes(cpu)) || measured.find(item => item.cpus.length === 0);
  if (selected) return selected.file;
  if (!files.length) throw new Error(`Steamworks4j requires ${LIBRARY}.`);
  throw new Error(`Steamworks4j requires ${cpu}; the selected files contain ${[...new Set(measured.flatMap(item => item.cpus))].join(", ")}.`);
}
function inspectRuntime({ runtimePath, runtimeVersion = "custom", upstreamRevision = "custom", arch, requiredArchitecture, hostArchitecture } = {}) {
  const executablePath = libraryPath(runtimePath, requiredArchitecture || arch), stat = fs.statSync(executablePath);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Steamworks4j requires a nonempty ${LIBRARY}.`);
  const cpus = architectures(executablePath), requested = requiredArchitecture || arch;
  const cpu = requested === "x64" ? "x86_64" : requested;
  if (cpu && cpus.length && !cpus.includes(cpu)) throw new Error(`Steamworks4j requires ${cpu}; this library contains ${cpus.join(", ")}.`);
  const manifest = path.join(path.dirname(executablePath), "helper.json");
  const record = fs.existsSync(manifest) ? JSON.parse(Bundle.readRegular(manifest, Bundle.LIMITS.manifestBytes).bytes) : null;
  const helper = record?.id === "java-steamworks" ? record : null;
  return { executablePath, architectures: cpus, runtimeVersion, upstreamRevision, sha256: Native.hashFile(executablePath),
    ...(helper?.wrapperVersion ? { wrapperVersion: helper.wrapperVersion } : {}),
    ...(helper?.abiProfile ? { abiProfile: helper.abiProfile } : {}),
    ...(cpus.length ? { architecture: cpus.includes("arm64") && cpus.includes("x86_64") ? "universal" : cpus[0] === "x86_64" ? "x64" : cpus[0] } : {}),
    needsRosetta: hostArchitecture === "arm64" && cpus.length > 0 && !cpus.includes("arm64") && cpus.includes("x86_64") };
}
async function extractArchive(archive, destination, signal) {
  const listed = Zip.readZipEntries(archive);
  if (!listed || listed.entries.length > 20000) throw new Error("The Steamworks4j download is not a supported JAR.");
  const names = new Set();
  for (const entry of listed.entries) {
    throwIfAborted(signal);
    const name = entry.name;
    if (!name || name.endsWith("/")) continue;
    if (name.includes("\\") || path.posix.isAbsolute(name) || name.split("/").some(part => !part || part === "." || part === "..") || names.has(name))
      throw new Error("The Steamworks4j JAR contains an unsafe or duplicate file.");
    names.add(name);
    if (![LIBRARY, "libsteam_api.dylib"].includes(path.posix.basename(name)) && !/(?:^|\/)(?:LICENSE|NOTICE|COPYING)(?:[._-]|$)/i.test(name)) continue;
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const bytes = Zip.readZipEntry(archive, entry, { maxOutputBytes: 16 * 1024 * 1024 });
    if (!bytes) throw new Error("The Steamworks4j JAR contains an unreadable native file.");
    fs.writeFileSync(target, bytes, { flag: "wx", mode: name.endsWith(".dylib") ? 0o755 : 0o644 });
  }
  libraryPath(destination);
}
function wrapperVersion(version) { return /^v?(\d+(?:\.\d+)+)/.exec(String(version || ""))?.[1] || null; }
function compatibleWith(pin, candidate) {
  const known = candidate?.wrapperVersion || wrapperVersion(candidate?.version);
  return (!known || known === pin.version) && (!pin.abiProfile || !candidate?.abiProfile || candidate.abiProfile === pin.abiProfile);
}
function createManager({ dependencies = {}, upstream = createSource() } = {}) {
  const manager = createPinnedNativeManager({ id: "java-steamworks", label: "Steamworks4j", upstream, sourceUrl: BASE,
    projectBuilds: { projectId: "java-steamworks", repository: "procrastinine/maclauncher-builds", upstreamMacDownloads: true,
      executableRelative: LIBRARY }, nativeLibrary: true,
    versionCompatibility: (wanted, installed) => wrapperVersion(wanted) === wrapperVersion(installed),
    resolveExecutable: root => libraryPath(root), inspectRuntime,
    dependencies: { extractArchive, ...dependencies } });
  const resolveSelection = manager.resolveSelection.bind(manager);
  manager.selectForWrapper = (pin, { userDataDir, settings = {}, ...options } = {}) => {
    const compatible = candidate => compatibleWith(pin, candidate);
    const subject = { runtimeId: manager.id, runtimeData: {} };
    const selected = resolveSelection(subject, settings, userDataDir, { ...options, compatible });
    if (selected?.ready && compatible(selected.install || selected)) return selected;
    const state = manager.getState({ userDataDir, settings: settings.runtimes?.[manager.id] });
    const installed = (state.installed || []).filter(row => row.ready !== false && compatible(row)).map(row => row.version);
    const version = managerDefaultVersion({ installed,
      listed: installed.length ? [] : (state.catalog?.versions || []).filter(version => compatible({ version })) });
    return version ? resolveSelection(subject, settings, userDataDir, { ...options, compatible, recommendedVersion: version })
      : { ...selected, version: null, ready: false, discoveryRequired: true };
  };
  manager.resolveSelection = (entry, settings, userDataDir, options = {}) => {
    if (entry?.runtimeId === "java" || entry?.moduleId === "java") {
      const required = require("./consumer").requirement(entry);
      return required ? manager.selectForWrapper(required.pin, { ...options, settings, userDataDir }) : null;
    }
    return resolveSelection(entry, settings, userDataDir, options);
  };
  const install = manager.installRuntime;
  manager.installRuntime = async ({ wrapperVersion: requiredWrapper, ...options } = {}) => {
    if (!requiredWrapper) return install(options);
    const pin = { version: requiredWrapper };
    let selected = manager.selectForWrapper(pin, options);
    if (selected.ready) return selected.install;
    if (selected.discoveryRequired) {
      // Install is already explicit or belongs to the approved Play plan.
      await manager.refreshCatalog({ userDataDir: options.userDataDir, signal: options.signal, logger: options.logger, force: true });
      selected = manager.selectForWrapper(pin, options);
    }
    if (!selected.version) throw new Error("No matching Steamworks4j JNI download is available.");
    return install({ ...options, version: selected.version });
  };
  manager.ui = { category: "tools", tabLabel: "Steamworks4j", sectionLabel: "Steamworks4j", order: 235 };
  return manager;
}
module.exports = createManager();
Object.assign(module.exports, { createManager, architectures, libraryPath, inspectRuntime, compatibleWith });
