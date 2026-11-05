const fs = require('node:fs'), path = require('node:path');
const Binary = require('./binary-compatibility');

// Resolve the declared dependencies of the selected plugin files. The host
// record describes libraries already loaded by its native plugin consumer.
// Unrelated installed libraries and release/version labels are not inputs.
async function resolvePluginLibraries(description, record, options = {}) {
  const root = fs.realpathSync(description.root), files = description.files || [], warnings = [];
  const directories = description.pluginDirectories?.length ? description.pluginDirectories :
    [...new Set(files.filter(file => file.format === 'macho').map(file => path.relative(root, path.dirname(file.path)) || '.'))];
  const realDirectory = directory => {
    try { return fs.realpathSync(directory); }
    catch (error) { warnings.push(`Plugin directory ${directory} is unavailable: ${error.message}`); return null; }
  };
  const selectedDirectories = directories.map(relative => ({ relative, real: realDirectory(path.resolve(root, relative)) })).filter(item => item.real);
  const pluginDirectories = selectedDirectories.map(item => item.real);
  const architecture = record.layout.architecture;
  const image = file => file.slices?.find(slice => slice.architecture === architecture) || (!architecture ? file.slices?.[0] : null);
  const original = file => file.realPath || (fs.existsSync(file.path) ? fs.realpathSync(file.path) : file.path);
  const byPath = new Map(files.filter(file => file.format === 'macho').map(file => [original(file), file]));
  const host = Object.values(record.libraries || {});
  const hostFor = (dependency, supplied) => {
    const id = supplied && image(supplied)?.installName?.path || dependency;
    if (!id) return null;
    const matches = host.filter(library => library.path === dependency || library.image.installName?.path === id);
    return matches.length === 1 ? matches[0] : null;
  };
  const fileDirectories = new Map([...new Set(files.filter(file => file.format === 'macho').map(file => path.dirname(file.path)))]
    .map(directory => [directory, realDirectory(directory)]));
  const candidates = files.filter(file => file.format === 'macho' && pluginDirectories.includes(fileDirectories.get(path.dirname(file.path))));
  const preparedDirectories = [...new Set(selectedDirectories.flatMap(({ real: directory, relative }) => {
    const logical = candidates.filter(file => fileDirectories.get(path.dirname(file.path)) === directory)
      .map(file => path.relative(root, path.dirname(file.path)) || '.');
    return logical.length ? logical : [relative];
  }))];
  const bindings = new Map(), consumed = new Map(), excludedFiles = new Set();
  const rememberBinding = (file, library) => {
    if (file) bindings.set(file.path, { source: file.path, target: library.path });
  };
  // Alternate aliases of a host-owned library must refer to that same image,
  // including an alias reached by a plugin's ordinary dynamic loading.
  for (const file of files.filter(file => file.format === 'macho')) {
    const library = hostFor(image(file)?.installName?.path, file);
    if (library) rememberBinding(file, library);
  }
  const hostFiles = new Map();
  for (const plugin of candidates) {
    const pending = [{ file: plugin, runPaths: [], pathContexts: [], optionalRoot: null }], visited = new Map(), selected = new Map();
    let failure = null;
    while (pending.length && !failure) {
      const { file, runPaths: inherited, pathContexts: inheritedContexts, optionalRoot } = pending.shift(), canonical = original(file);
      if (visited.has(canonical) && (visited.get(canonical) || optionalRoot)) continue;
      visited.set(canonical, !optionalRoot); selected.set(file.path, { file, optionalRoot });
      let rejected = false;
      const reject = reason => {
        rejected = true;
        if (!optionalRoot) { failure = reason; return; }
        excludedFiles.add(optionalRoot);
        warnings.push(`${path.basename(optionalRoot)} was not added as an optional dependency: ${reason}. Its plugin remains available.`);
      };
      const checked = Binary.compatibility({ ...description, files: [file], requiredPaths: [file.path] }, record, options);
      if (!checked.compatible) { reject(checked.reason); continue; }
      warnings.push(...checked.warnings.map(warning => `${path.basename(file.path)}: ${warning}`));
      const native = image(file);
      if (!native) continue;
      const runPaths = Binary.nativeRunPaths(file.path, native, record.executablePath, inherited);
      const pathContexts = [...(native.runPaths || []).flatMap(value =>
        Binary.nativeRunPaths(file.path, { runPaths: [value] }, record.executablePath, []).map(directory => ({ directory,
          relative: (value === '@loader_path' || value.startsWith('@loader_path/')) && (directory === root || directory.startsWith(root + path.sep)) }))), ...inheritedContexts];
      for (const dependency of native.dependencies || []) {
        if (/^\/(?:usr\/lib|System\/Library)\//.test(dependency.path)) continue;
        const resolved = Binary.resolveNativeDependency(file.path, native, dependency.path, {
          executablePath: record.executablePath, runPaths
        });
        const supplied = resolved && byPath.get(resolved);
        const library = resolved && record.libraries?.[resolved] || (!resolved || supplied ? hostFor(dependency.path, supplied) : null);
        if (library) {
          if (supplied && resolved !== library.path) {
            let relative = dependency.path.startsWith('@loader_path/');
            if (dependency.path.startsWith('@rpath/')) {
              const search = pathContexts.find(({ directory }) => {
                try { return fs.realpathSync(path.join(directory, dependency.path.slice(7))) === resolved; } catch { return false; }
              });
              relative = search?.relative;
            }
            if (!relative) {
              reject(`The dependency ${dependency.path} bypasses the prepared host-library neighborhood. Its source is unchanged`);
              break;
            }
          }
          rememberBinding(supplied, library); hostFiles.set(library.path, library);
          for (const item of (native.imports || []).filter(item => item.library === dependency.path && !item.weak)) {
            const found = Binary.libraryExport(record, library.path, item.symbol);
            if (found === false) { reject(`${path.basename(library.path)} does not export required symbol ${item.symbol}`); break; }
            if (found == null) warnings.push(`${path.basename(file.path)}: could not establish ${item.symbol} in its host dependency.`);
          }
          if (rejected) break;
          continue;
        }
        if (supplied) { pending.push({ file: supplied, runPaths, pathContexts,
          optionalRoot: optionalRoot || (dependency.kind === 'weak' ? supplied.path : null) }); continue; }
        if (resolved && resolved !== root && !resolved.startsWith(root + path.sep)) {
          warnings.push(`${path.basename(file.path)}: dependency outside the selected component was not added: ${dependency.path}`);
        } else warnings.push(`${path.basename(file.path)}: dependency inspection is unresolved: ${dependency.path}`);
      }
    }
    if (failure) {
      excludedFiles.add(plugin.path);
      warnings.push(`${path.basename(plugin.path)} was not added: ${failure}. Other plugins and the runtime defaults remain available.`);
    } else for (const [name, item] of selected)
      if (!item.optionalRoot || !excludedFiles.has(item.optionalRoot)) consumed.set(name, item.file);
  }
  if (!candidates.length) warnings.push('No native plugin file was found in the selected plugin directories. Runtime defaults remain available.');
  const bound = [...bindings.values()];
  for (const binding of bound) {
    const library = record.libraries?.[binding.target];
    if (library) hostFiles.set(library.path, library);
  }
  const preparedFiles = [...consumed.values()].filter(file => !bindings.has(file.path)).map(file => ({ ...file,
    // A symlink would retain the source image's loader-relative neighborhood.
    // A byte-identical clone lets existing relative commands use host aliases.
    relocate: bound.length > 0 && (image(file)?.dependencies || []).some(dependency =>
      dependency.path.startsWith('@loader_path/') || dependency.path.startsWith('@rpath/'))
  }));
  return { description: { ...description, files: preparedFiles, videoPreparation: {
    pluginDirectories: preparedDirectories, bindings: bound, excludedFiles: [...excludedFiles], warnings: [...new Set(warnings)],
    hostFiles: [...hostFiles.values()].map(library => ({ path: library.path, identity: library.identity }))
  } }, warnings };
}

module.exports = { resolvePluginLibraries };
