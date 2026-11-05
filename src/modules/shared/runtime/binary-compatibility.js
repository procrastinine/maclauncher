const fs = require('node:fs'), path = require('node:path');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { inspectMachOExportInfo } = require('./macho-exports');
const { inspectFile, compareVersions } = require('./translator-description');
const { wineLayout } = require('./wine-layout');

// Per-installed-engine record, invalidated by file identity, never version.
async function wineCompatibilityRecord(install) {
  const layout = wineLayout(install), modules = {}, warnings = [];
  if (layout.unixRoot) for (const name of fs.readdirSync(layout.unixRoot).sort().filter(name => name.endsWith('.so') || name.endsWith('.dylib'))) {
    const file = path.join(layout.unixRoot, name);
    try {
      const info = readMachOLoadCommands(file, { architecture: layout.architecture }), stat = fs.statSync(file);
      modules[name] = { path: file, identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs],
        image: info.slices[0], ...await inspectMachOExportInfo(file, { arch: layout.architecture }) };
    } catch (error) { warnings.push(`${name}: ${error.message}`); }
  }
  return { layout, modules, warnings };
}
function requiredMachine(executableArchitecture) {
  return { x86: 0x14c, i386: 0x14c, x64: 0x8664, x86_64: 0x8664, arm64: 0xaa64, aarch64: 0xaa64 }[executableArchitecture];
}
function moduleExport(record, name, symbol, visited = new Set()) {
  if (visited.has(name)) return null;
  visited.add(name);
  const module = record.modules[name];
  if (!module) return null; // Inspection failure is not proof of a missing export.
  if (module.exports.includes(symbol)) return true;
  let unknown = module.complete !== true;
  for (const item of (module.reexports || []).filter(item => item.symbol === symbol)) {
    const dependency = module.image.dependencies[item.ordinal - 1];
    const result = dependency && moduleExport(record, path.basename(dependency.path), item.imported, visited);
    if (result === true) return true;
    if (result == null) unknown = true;
  }
  for (const dependency of module.image.dependencies.filter(item => item.kind === 'reexport')) {
    const result = moduleExport(record, path.basename(dependency.path), symbol, visited);
    if (result === true) return true;
    if (result == null) unknown = true;
  }
  return unknown ? null : false;
}
function compatibility(description, record, { macOSVersion, executableArchitecture } = {}) {
  const warnings = [], machine = requiredMachine(executableArchitecture), expectedUnix = record.layout.architecture;
  const incompatible = reason => ({ compatible: false, reason, warnings });
  const files = [];
  for (const file of description.files || []) {
    // Alternate PE/Unix architecture folders are installed once and serve other consumers.
    const parent = (file.relative || '').split('/').find(part => part.endsWith('-windows') || part.endsWith('-unix'));
    if (parent?.endsWith('-windows') && machine && requiredMachine(parent.slice(0, -8)) !== machine) continue;
    if (parent?.endsWith('-unix') && record.layout.unixName && parent !== record.layout.unixName) continue;
    if (!fs.existsSync(file.path)) return incompatible(`Required file is missing: ${file.path}`);
    const actual = inspectFile(file); files.push(actual);
    if (actual.format === 'pe' && machine && actual.machine !== machine) return incompatible(`${path.basename(file.path)} has no PE machine for ${executableArchitecture}`);
    if (actual.format !== 'macho') { if (actual.format === 'unknown') warnings.push(`Could not inspect ${file.path}`); continue; }
    if (expectedUnix && !actual.cpuSlices.includes(expectedUnix)) return incompatible(`${path.basename(file.path)} has no ${expectedUnix} CPU slice`);
    const image = actual.slices.find(slice => slice.architecture === expectedUnix) || actual.slices[0];
    if (macOSVersion && image.minimumMacOS && compareVersions(image.minimumMacOS, macOSVersion) > 0)
      return incompatible(`${path.basename(file.path)} requires macOS ${image.minimumMacOS}`);
    if (!image.importsComplete) warnings.push(`Imports could not be fully inspected: ${file.path}`);
    for (const item of image.imports || []) {
      if (item.weak || !item.library || /^\/(?:usr\/lib|System\/Library)\//.test(item.library)) continue;
      const name = path.basename(item.library);
      if (!record.modules[name]) { warnings.push(`Dependency was not inspected: ${item.library}`); continue; }
      // Only the actual dependency and its reexports can satisfy a two-level import.
      const found = moduleExport(record, name, item.symbol);
      if (found === false) return incompatible(`${name} does not export required symbol ${item.symbol}`);
      if (found == null) warnings.push(`Could not establish export ${item.symbol} from ${name}`);
    }
  }
  if (machine && description.files?.some(file => file.format === 'pe') && !files.some(file => file.format === 'pe'))
    return incompatible(`No translator PE files for ${executableArchitecture}`);
  return { compatible: true, reason: null, warnings };
}
module.exports = { wineCompatibilityRecord, compatibility, requiredMachine, moduleExport };
