const fs = require("node:fs");
const path = require("node:path");

const ARCHITECTURES = ["32", "64", "arm64", "universal", "unspecified"];
const PLATFORMS = ["macos", "windows", "linux", "android"];
const values = value => String(value || "").toLowerCase().split(/[,;\s]+/).filter(Boolean);
const platforms = value => values(value).map(item => item === "mac" ? "macos" : item).filter(item => PLATFORMS.includes(item));
function architectureConfig(config = {}) {
  const bits = new Set(), cpus = new Set();
  for (const token of [...values(config.osarch), ...values(config.arch), ...values(config.architecture), ...values(config.cpu_arch), ...values(config.cpuarchitecture)]) {
    if (["32", "32bit", "32-bit"].includes(token)) bits.add("32");
    else if (["64", "64bit", "64-bit"].includes(token)) bits.add("64");
    else if (["arm64", "aarch64", "apple_silicon", "applesilicon"].includes(token)) { bits.add("64"); cpus.add("arm64"); }
    else if (["x86_64", "amd64", "x64", "intel64"].includes(token)) { bits.add("64"); cpus.add("x86_64"); }
    else if (["x86", "i386", "i686", "intel32"].includes(token)) { bits.add("32"); cpus.add("x86"); }
    else if (["universal", "universal2"].includes(token)) { bits.add("64"); cpus.add("universal"); }
  }
  const architectures = [...bits].filter(bit => bit !== "64" || cpus.has("x86_64") || !cpus.has("arm64") && !cpus.has("universal"));
  if (cpus.has("arm64")) architectures.push("arm64");
  if (cpus.has("universal")) architectures.push("universal");
  return { architectures: [...new Set(architectures)], architectureBits: [...bits], architectureCpu: [...cpus], architectureSource: bits.size || cpus.size ? "depot" : "unspecified" };
}
function matchesSteamArchitecture(depot, architecture = "all") {
  if (architecture === "all") return true;
  const declared = depot.architectures || [], bits = depot.architectureBits || declared.filter(item => item === "32" || item === "64"), cpus = depot.architectureCpu || [];
  if (architecture === "unspecified") return !declared.length;
  // Steam's osarch=64 describes bitness, including Apple Silicon depots.
  // Untagged depots may hold shared resources or every executable together.
  if (!declared.length) return true;
  if (architecture === "arm64") return cpus.length ? cpus.includes("arm64") || cpus.includes("universal") : bits.includes("64");
  if (architecture === "universal") return cpus.length ? cpus.includes("universal") : bits.includes("64");
  if (architecture === "64") return bits.includes("64");
  return architecture === "32" && bits.includes("32");
}
function steamArchitectureCatalog(info = {}, depots = []) {
  const common = info.common || {}, appPlatforms = platforms(common.oslist), extended = new Set(values(common.osextended));
  const evidence = Object.fromEntries(PLATFORMS.map(os => [os, new Set()]));
  const launchOptions = Object.entries(info.config?.launch || {}).filter(([, option]) => option && typeof option === "object").map(([id, option]) => {
    let oses = platforms(option.config?.oslist || option.oslist);
    if (!oses.length) oses = /\.app(?:\/|$)/i.test(option.executable || "") ? ["macos"] : /\.exe$/i.test(option.executable || "") ? ["windows"] : appPlatforms.length === 1 ? appPlatforms : [];
    const config = architectureConfig({ ...option, ...option.config });
    for (const os of oses) for (const arch of config.architectures) evidence[os].add(arch);
    return { id, executable: String(option.executable || ""), description: String(option.description || ""), platforms: oses, architectures: config.architectures,
      architectureBits: config.architectureBits, architectureCpu: config.architectureCpu, architectureSource: config.architectures.length ? "launch" : "unspecified" };
  });
  for (const depot of depots) for (const os of depot.platforms.length ? depot.platforms : appPlatforms) for (const arch of depot.architectures) evidence[os].add(arch);
  const commonArch = architectureConfig(common);
  // macOS has separate compatibility flags. A Windows-only 64-bit requirement
  // must not turn an unclassified Mac bundle into a claimed Intel build.
  for (const os of appPlatforms.filter(os => os !== "macos")) for (const arch of commonArch.architectures) evidence[os].add(arch);
  if (extended.has("macos64")) evidence.macos.add("64");
  if (extended.has("macos32")) evidence.macos.add("32");
  if (["macosapplesilicon", "macosarm64"].some(flag => extended.has(flag))) evidence.macos.add("arm64");
  if (["macosuniversal", "macosuniversal2"].some(flag => extended.has(flag))) evidence.macos.add("universal");
  const architectures = {}, architectureNotes = {}, architectureLabels = {};
  for (const os of PLATFORMS) {
    architectures[os] = ARCHITECTURES.filter(arch => evidence[os].has(arch));
    if (!architectures[os].length) architectures[os] = ["unspecified"];
    architectureLabels[os] = { "32": "32-bit", "64": "64-bit (CPU not specified)", arm64: os === "macos" ? "Apple Silicon" : "ARM64", universal: "Universal", unspecified: "Not specified" };
    const matching = depots.filter(depot => !depot.platforms.length || depot.platforms.includes(os));
    architectureNotes[os] = architectures[os][0] === "unspecified"
      ? "Steam does not specify the executable architecture. Untagged depots do not establish separate 32-bit or 64-bit editions."
      : "Architecture comes from publisher platform, launch and depot metadata. Shared or untagged depots remain included; one depot can contain several executable architectures. A 64-bit flag alone does not identify its CPU.";
    if (os === "macos" && architectures[os].includes("arm64") && matching.some(depot => depot.architectureBits.includes("64") && !depot.architectureCpu.length))
      architectureNotes[os] += " Apple Silicon support is advertised, and its files can share a depot marked 64-bit.";
  }
  return { architectureSchema: 1, platformSchema: 1, architectures, architectureLabels, architectureNotes, launchOptions };
}
function steamLibraryArchitectures(info = {}) {
  const depots = Object.entries(info.depots || {}).filter(([id, depot]) => /^\d+$/.test(id) && depot && typeof depot === "object")
    .map(([, depot]) => ({ platforms: platforms(depot.config?.oslist), ...architectureConfig(depot.config) }));
  const { architectures } = steamArchitectureCatalog(info, depots);
  return { architecturesByPlatform: architectures, nativeAppleSilicon: architectures.macos.some(arch => arch === "arm64" || arch === "universal") };
}

// Read only bounded Mach-O headers. Legacy 32-bit binaries remain identifiable
// without executing a game or treating a bundled helper library as its entry.
function inspectMachOArchitecture(file) {
  let fd;
  try {
    const stat = fs.statSync(file); if (!stat.isFile() || stat.size < 28) return null;
    fd = fs.openSync(file, "r");
    const read = (offset, length) => { if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size - length) throw new Error("Invalid executable header."); const buffer = Buffer.alloc(length); if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw new Error("Incomplete executable header."); return buffer; };
    const thin = offset => {
      const header = read(offset, 28), magic = header.readUInt32BE(0), little = [0xcefaedfe, 0xcffaedfe].includes(magic);
      if (![0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return null;
      const word = position => little ? header.readUInt32LE(position) : header.readUInt32BE(position);
      if (word(12) !== 2) return null;
      return ({ 7: "x86", 16777223: "x86_64", 16777228: "arm64", 18: "ppc", 16777234: "ppc64" })[word(4)] || null;
    };
    const header = read(0, 8), magic = header.readUInt32BE(0), fat = [0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic);
    const cpus = new Set();
    if (!fat) { const cpu = thin(0); if (cpu) cpus.add(cpu); }
    else {
      const little = [0xbebafeca, 0xbfbafeca].includes(magic), wide = [0xcafebabf, 0xbfbafeca].includes(magic), count = little ? header.readUInt32LE(4) : header.readUInt32BE(4), stride = wide ? 32 : 20;
      if (!count || count > 32) return null;
      const table = read(8, count * stride);
      for (let index = 0; index < count; index++) {
        const start = index * stride, offset = wide ? Number(little ? table.readBigUInt64LE(start + 8) : table.readBigUInt64BE(start + 8)) : little ? table.readUInt32LE(start + 8) : table.readUInt32BE(start + 8);
        if (offset < 8 + count * stride) return null;
        const cpu = thin(offset); if (cpu) cpus.add(cpu);
      }
    }
    if (!cpus.size) return null;
    const architectures = [...new Set([...cpus].map(cpu => cpu === "arm64" ? "arm64" : ["x86", "ppc"].includes(cpu) ? "32" : "64"))];
    if (cpus.has("arm64") && cpus.has("x86_64")) architectures.push("universal");
    return { architectures, architectureCpu: [...cpus], architectureSource: "binary", architectureLabel: cpus.has("arm64") && cpus.has("x86_64") ? "Universal (Intel and Apple Silicon)" : cpus.size === 1 ? ({ x86: "Intel 32-bit", x86_64: "Intel 64-bit", arm64: "Apple Silicon", ppc: "PowerPC 32-bit", ppc64: "PowerPC 64-bit" })[[...cpus][0]] : "Multiple architectures" };
  } catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}
async function inspectInstalledMacArchitecture(gamePath) {
  const queue = [{ directory: gamePath, depth: 0 }]; let remaining = 256;
  const inspect = file => {
    try { const relative = path.relative(fs.realpathSync(gamePath), fs.realpathSync(file)); if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null; return inspectMachOArchitecture(file); } catch { return null; }
  };
  const inspectBundle = file => {
    const executable = require("../modules/shared/runtime/app-bundle").readAppBundleExecutableName(file);
    if (!executable) return null;
    const executablePath = path.join(file, "Contents/MacOS", executable), result = inspect(executablePath);
    return result ? { ...result, executable: executablePath } : null;
  };
  try {
    if (fs.statSync(gamePath).isFile()) { const result = inspect(gamePath); if (result) return { ...result, executable: gamePath }; }
    if (/\.app$/i.test(gamePath)) { const result = inspectBundle(gamePath); if (result) return result; }
  } catch { /* Missing installs retain an unspecified architecture. */ }
  while (queue.length && remaining > 0) {
    const { directory, depth } = queue.shift(); let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (--remaining < 0) break;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && /\.app$/i.test(entry.name)) {
        if (/^(?:crash|unins|setup|install|report|helper)/i.test(entry.name)) continue;
        const result = inspectBundle(file); if (result) return result;
      } else if (entry.isDirectory() && depth < 1 && !/^(?:redist|node_modules|\.git|__MACOSX)$/i.test(entry.name)) queue.push({ directory: file, depth: depth + 1 });
      else if (entry.isFile() && !path.extname(entry.name) && !/^(?:crash|unins|setup|install|report|helper)/i.test(entry.name)) { const result = inspect(file); if (result) return { ...result, executable: file }; }
    }
  }
  return { architectures: ["unspecified"], architectureSource: "unspecified", architectureLabel: "Not specified" };
}
module.exports = { ARCHITECTURES, STEAM_PLATFORMS: PLATFORMS, steamPlatforms: platforms, architectureConfig, matchesSteamArchitecture, steamArchitectureCatalog, steamLibraryArchitectures, inspectMachOArchitecture, inspectInstalledMacArchitecture };
