const fs = require('node:fs'), path = require('node:path');
const { readMachOLoadCommands } = require('./macho-load-commands');
const { inspectMachOExportInfo } = require('./macho-exports');
const { compareVersions } = require('./translator-description');
const { wineLayout } = require('./wine-layout');
const { binaryFiles } = require('./binary-files');

// Per-installed-engine record, invalidated by file identity, never version.
async function wineCompatibilityRecord(install, options) {
  const { nativeRoots = [] } = options || {};
  const layout = wineLayout(install), modules = {}, warnings = [];
  if (layout.unixRoot) for (const name of fs.readdirSync(layout.unixRoot).sort().filter(name => name.endsWith('.so') || name.endsWith('.dylib'))) {
    const file = path.join(layout.unixRoot, name);
    try {
      if (options && name === 'winegstreamer.so') {
        modules[name] = await nativeLibrary(file, layout.architecture, warnings);
        continue;
      }
      const info = readMachOLoadCommands(file, { architecture: layout.architecture }), stat = fs.statSync(file);
      modules[name] = { path: file, identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs],
        image: info.slices[0], ...await inspectMachOExportInfo(file, { arch: layout.architecture }) };
    } catch (error) { warnings.push(`${name}: ${error.message}`); }
  }
  const record = { layout, modules, warnings };
  return options ? completeWineNativeLibraries(record, install, { nativeRoots }) : record;
}
// Demand-driven completion reuses the existing Wine module record and never
// scans its Unix directory again. Ordinary compatibility keeps its old path.
async function completeWineNativeLibraries(record, install, { nativeRoots = [] } = {}) {
  const { layout, modules, warnings } = record;
  record.executablePath = install.executablePath;
  record.libraries = {};
  const seed = modules['winegstreamer.so'];
  const pending = seed ? [{ file: seed.path, module: seed.image.importsComplete === undefined ? null : seed, runPaths: [] }] : [];
  const visited = new Set();
  while (pending.length) {
    const item = pending.shift();
    try {
      const file = fs.realpathSync(item.file);
      if (visited.has(file)) continue;
      visited.add(file);
      const module = item.module || await nativeLibrary(file, layout.architecture, warnings);
      const runPaths = nativeRunPaths(file, module.image, install.executablePath, item.runPaths);
      const dependencies = Object.create(null);
      record.libraries[file] = { ...module, path: file, runPaths, dependencies };
      for (const dependency of module.image.dependencies) {
        const target = resolveNativeDependency(file, module.image, dependency.path,
          { executablePath: install.executablePath, runPaths, libraryPaths: nativeRoots });
        dependencies[dependency.path] = target;
        if (target) pending.push({ file: target, runPaths });
        else if (!systemLibrary(dependency.path)) warnings.push(`Could not resolve ${dependency.kind} dependency ${dependency.path} from ${file}`);
      }
    } catch (error) { warnings.push(`${item.file}: ${error.message}`); }
  }
  return record;
}
async function nativeLibrary(file, architecture, warnings) {
  const info = readMachOLoadCommands(file, { architecture, imports: true }), stat = fs.statSync(file);
  let exports = { exports: [], reexports: [], complete: false };
  try { exports = await inspectMachOExportInfo(file, { arch: architecture }); }
  catch (error) { warnings.push(`${file}: ${error.message}`); }
  if (!info.slices[0].importsComplete) warnings.push(`Imports could not be fully inspected: ${file}`);
  if (!exports.complete) warnings.push(`Exports could not be fully inspected: ${file}`);
  return { path: file, identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs], image: info.slices[0], ...exports };
}
function systemLibrary(library) { return /^\/(?:usr\/lib|System\/Library)\//.test(library); }
function nativePath(value, file, executablePath) {
  if (value === '@loader_path' || value.startsWith('@loader_path/')) return path.resolve(path.dirname(file), '.' + value.slice(12));
  if (value === '@executable_path' || value.startsWith('@executable_path/'))
    return executablePath ? path.resolve(path.dirname(executablePath), '.' + value.slice(16)) : null;
  return path.isAbsolute(value) ? value : null;
}
function nativeRunPaths(file, image, executablePath, inherited) {
  return [...new Set([...(image.runPaths || []).map(value => nativePath(value, file, executablePath)), ...inherited].filter(Boolean))];
}
// Resolve only declared edges using the consuming image's actual load context.
// Missing context or an inaccessible candidate is unknown, never a load verdict.
function resolveNativeDependency(file, image, library, { executablePath, runPaths = [], libraryPaths = [] } = {}) {
  if (!library || systemLibrary(library)) return null;
  const candidates = libraryPaths.map(root => path.join(root, path.basename(library)));
  if (library.startsWith('@rpath/')) {
    for (const root of nativeRunPaths(file, image, executablePath, runPaths)) candidates.push(path.join(root, library.slice(7)));
  } else {
    const target = nativePath(library, file, executablePath);
    if (target) candidates.push(target);
  }
  for (const candidate of new Set(candidates)) {
    try { if (fs.statSync(candidate).isFile()) return fs.realpathSync(candidate); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null; }
  }
  return null;
}
function requiredMachine(executableArchitecture) {
  return { x86: 0x14c, i386: 0x14c, x64: 0x8664, x86_64: 0x8664, arm64: 0xaa64, aarch64: 0xaa64 }[executableArchitecture];
}
function wineDependency(record, library) {
  const name = path.basename(library), target = record.modules[name];
  if (!target) return null;
  if ([name, `@rpath/${name}`, `@loader_path/${name}`].includes(library)) return name;
  if (path.isAbsolute(library) && target.path) {
    try { if (fs.realpathSync(library) === fs.realpathSync(target.path)) return name; } catch {}
  }
  return null;
}
function moduleExport(record, name, symbol, visited = new Set(), native = false) {
  if (visited.has(name)) return null;
  visited.add(name);
  const module = (native ? record.libraries : record.modules)?.[name];
  if (!module) return null; // Inspection failure is not proof of a missing export.
  if (module.exports.includes(symbol)) return true;
  let unknown = module.complete !== true;
  for (const item of (module.reexports || []).filter(item => item.symbol === symbol)) {
    const dependency = module.image.dependencies[item.ordinal - 1];
    const target = dependency && (native ? module.dependencies[dependency.path] : wineDependency(record, dependency.path));
    const result = target ? moduleExport(record, target, item.imported, visited, native) : null;
    if (result === true) return true;
    if (result == null) unknown = true;
  }
  for (const dependency of module.image.dependencies.filter(item => item.kind === 'reexport')) {
    const target = native ? module.dependencies[dependency.path] : wineDependency(record, dependency.path);
    const result = target ? moduleExport(record, target, symbol, visited, native) : null;
    if (result === true) return true;
    if (result == null) unknown = true;
  }
  return unknown ? null : false;
}
function libraryExport(record, file, symbol) { return moduleExport(record, file, symbol, new Set(), true); }
function compatibility(description, record, { macOSVersion, executableArchitecture } = {}) {
  const warnings = [], machine = requiredMachine(executableArchitecture), expectedUnix = record.layout.architecture;
  const incompatible = reason => ({ compatible: false, reason, warnings });
  const requiredPaths = [...(description.requiredPaths || [])];
  if (description.entryPoint && description.component === 'vulkan-driver') requiredPaths.push(description.entryPoint);
  if (description.icd) {
    try { const icd = JSON.parse(fs.readFileSync(description.icd, 'utf8')); requiredPaths.push(path.resolve(path.dirname(description.icd), icd.ICD.library_path)); } catch {}
  }
  const selected = binaryFiles(description.files || [], { machine, architecture: expectedUnix, requiredPaths });
  if (selected.missing.length) return incompatible(selected.missing[0].reason);
  for (const file of selected.files) {
    if (!fs.existsSync(file.path)) return incompatible(`Required file is missing: ${file.path}`);
    const actual = file;
    if (actual.format === 'pe' && machine && actual.machine !== machine) return incompatible(`${path.basename(file.path)} has no PE machine for ${executableArchitecture}`);
    if (actual.format !== 'macho') { if (actual.format === 'unknown') warnings.push(`Could not inspect ${file.path}`); continue; }
    if (expectedUnix && !actual.cpuSlices.includes(expectedUnix)) return incompatible(`${path.basename(file.path)} has no ${expectedUnix} CPU slice`);
    const image = actual.slices.find(slice => slice.architecture === expectedUnix) || actual.slices[0];
    if (macOSVersion && image.minimumMacOS && compareVersions(image.minimumMacOS, macOSVersion) > 0)
      return incompatible(`${path.basename(file.path)} requires macOS ${image.minimumMacOS}`);
    if (!image.importsComplete) warnings.push(`Imports could not be fully inspected: ${file.path}`);
    for (const item of image.imports || []) {
      if (item.weak || !item.library || /^\/(?:usr\/lib|System\/Library)\//.test(item.library)) continue;
      const name = wineDependency(record, item.library);
      if (!name) { warnings.push(`Dependency was not established as a Wine module: ${item.library}`); continue; }
      // Only the actual dependency and its reexports can satisfy a two-level import.
      const found = moduleExport(record, name, item.symbol);
      if (found === false) return incompatible(`${name} does not export required symbol ${item.symbol}`);
      if (found == null) warnings.push(`Could not establish export ${item.symbol} from ${name}`);
    }
  }
  return { compatible: true, reason: null, warnings, files: selected.files };
}
module.exports = { wineCompatibilityRecord, completeWineNativeLibraries, compatibility, requiredMachine, moduleExport, resolveNativeDependency, nativeRunPaths, libraryExport };
