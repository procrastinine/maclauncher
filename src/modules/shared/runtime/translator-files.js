const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Writable = require('../writable-input');
const { cloneOrCopy } = require('../copy-file');
const { fileDigest } = require('./verified-identity');
const { requiredMachine } = require('./binary-compatibility');
const warn = require('../graphics-warning');

const cpuFolder = machine => ({ 332: 'i386-windows', 34404: 'x86_64-windows', 43620: 'aarch64-windows' })[machine];
function selectedDescriptions(plan) {
  if (plan?.apiMode) {
    const selected = new Map();
    const add = (description, inherited) => {
      const key = description.id || description.root || description, current = selected.get(key);
      if (current) { current.inherited &&= inherited; return; }
      selected.set(key, { ...description, inherited });
    };
    for (const [role, row] of Object.entries(plan.components || {}))
      if (role !== 'd3d-renderer' && row.used)
        add(row.used, Boolean(row.inherited && !row.fallback));
    for (const description of plan.additional || []) add(description, Boolean(description.inherited));
    return [...selected.entries()].map(([key, description]) => ({ ...description, files: ['vulkan-driver', 'video'].includes(description.component) ? description.files : (plan.placements || [])
      .filter(placement => (placement.description.id || placement.description.root || placement.description) === key)
      .map(placement => {
        const consumers = (placement.roles || []).map(role => plan.components?.[role]).filter(row => row?.used);
        return { ...placement.file, inherited: consumers.length ? consumers.every(row => row.inherited && !row.fallback) : description.inherited };
      }) }));
  }
  return [...Object.values(plan?.components || {}).filter(row => row.used && (plan.runtime === 'sikarugir' || !row.inherited || row.fallback))
    .map(row => ({ ...row.used, inherited: row.inherited })), ...(plan?.additional || [])];
}
function filesIdentity(descriptions) {
  return descriptions.map(item => [item.id, item.files.map(file => [file.path, fs.existsSync(file.path) ? fileDigest(file.path).sha256 : null])]);
}
/** Shared, content-keyed links to ordinary runtime installations. No per-game payload copies. */
async function prepareTranslatorFiles(plan, { userDataDir, layout, signal, logger = console } = {}, previousIdentity) {
  const selected = selectedDescriptions(plan), links = {}, native = [], dllOverrides = [], env = {};
  const inputs = filesIdentity(selected);
  // Advance a stale generation deterministically; active paths are never moved or replaced.
  const identity = crypto.createHash('sha256').update(JSON.stringify(previousIdentity ? [layout.architecture, inputs, previousIdentity] : [layout.architecture, inputs])).digest('hex');
  const store = path.join(userDataDir, 'graphics/wine-translators'), root = path.join(store, identity);
  Writable.assertOwnDirectory(userDataDir, store);
  Writable.assertOwnDirectory(store, root);
  let stale;
  async function link(source, relative) {
    const original = fs.realpathSync(source);
    const target = path.join(root, relative); Writable.assertOwnDirectory(root, path.dirname(target));
    try {
      const current = fs.lstatSync(target);
      if (!current.isSymbolicLink() || fs.realpathSync(target) !== original)
        throw stale = new Error('The prepared translator link changed.');
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (fs.lstatSync(target, { throwIfNoEntry: false })) throw stale = new Error('The prepared translator link is incomplete.');
      try { await fs.promises.symlink(source, target); }
      catch (race) {
        if (race.code !== 'EEXIST') throw race;
        if (!fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink() || !fs.existsSync(target) || fs.realpathSync(target) !== original)
          throw stale = new Error('The prepared translator link changed during preparation.');
      }
    }
    return target;
  }
  try {
  if (plan.apiMode && plan.runtime === 'crossover') env.CX_GRAPHICS_BACKEND = 'wined3d';
  for (const item of selected) {
    signal?.throwIfAborted();
    if (!plan.apiMode && plan.runtime === 'crossover' && item.included && item.component === 'd3d-renderer') { env.CX_GRAPHICS_BACKEND = item.backend || item.engine; continue; }
    if (plan.runtime === 'crossover' && ['d3d-renderer', 'd3d12'].includes(item.component) && (plan.apiMode || item.engine !== 'vkd3d')) env.CX_GRAPHICS_BACKEND = 'wined3d';
    if (item.engine === 'vkd3d' && !plan.apiMode) continue; // Legacy Wine d3d12 stays in its normal builtin tree.
    if (item.component === 'vulkan-driver') {
      const json = item.icd ? { path: item.icd } : item.files.find(file => file.format === 'json' && (() => { try { return Boolean(JSON.parse(fs.readFileSync(file.path)).ICD); } catch { return false; } })());
      const descriptor = json ? JSON.parse(fs.readFileSync(json.path, 'utf8')) : null;
      const driver = json ? path.resolve(path.dirname(json.path), descriptor.ICD.library_path) : item.entryPoint || item.files.find(file => file.format === 'macho' && !/libvulkan(?:\.\d+)*\.dylib$/.test(file.path))?.path;
      const loader = item.files.find(file => /libvulkan(?:\.\d+)*\.dylib$/.test(file.path))?.path;
      if (!driver) throw new Error('The selected Vulkan driver file is missing.');
      Object.assign(env, require('../vulkan').driverEnvironment({ driver, icd: json?.path, backend: item.engine }, root));
      const library = loader || driver;
      links[`lib/wine/${layout.unixName}/libMoltenVK.dylib`] = library;
      if (plan.runtime === 'crossover') env.CX_LIBVULKAN = library;
      else if (loader) links[`lib/wine/${layout.unixName}/libvulkan.1.dylib`] = loader;
      continue;
    }
    if (item.component === 'video') {
      const directories = [...new Set(item.files.filter(file => file.format === 'macho').map(file => path.dirname(file.path)))];
      env.GST_PLUGIN_PATH = directories.join(path.delimiter); env.GST_PLUGIN_PATH_1_0 = env.GST_PLUGIN_PATH;
      continue;
    }
    for (const file of plan.apiMode ? item.files : plan.compatibility?.[item.id]?.files || item.files) {
      if (file.format === 'pe') {
        if (!plan.apiMode && item.component === 'd3d12' && !/^d3d12/i.test(path.basename(file.path))) continue;
        const architecture = cpuFolder(file.machine); if (!architecture) continue;
        const name = path.basename(file.path), module = name.replace(/\.dll$/i, '');
        if (file.form === 'native') { if (!(plan.apiMode ? file.inherited : item.inherited)) native.push({ source: file.path, name, machine: file.machine }); dllOverrides.push(`${module}=n,b`); }
        else { const relative = `lib/wine/${architecture}/${name}`; links[relative] = await link(file.path, relative); dllOverrides.push(`${module}=b`); }
      } else if (file.format === 'macho' && file.path.endsWith('.so')) {
        if (layout.architecture && !file.cpuSlices.includes(layout.architecture)) continue;
        let source = file.path;
        if (path.basename(fs.realpathSync(source)) === 'libd3dshared.dylib') {
          const original = fs.realpathSync(source), external = path.join(root, 'external'); Writable.assertOwnDirectory(root, external);
          source = path.join(external, 'libd3dshared.dylib');
          if (!fs.existsSync(source)) try { await cloneOrCopy(original, source, { signal, exclusive: true }); }
          catch (race) { if (race.code !== 'EEXIST' || fileDigest(original).sha256 !== fileDigest(source).sha256) throw race; }
          const framework = path.join(path.dirname(original), 'D3DMetal.framework');
          if (fs.existsSync(framework)) await link(framework, 'external/D3DMetal.framework');
          env.CX_APPLEGPTK_LIBD3DSHARED_PATH = source;
        }
        const relative = `lib/wine/${layout.unixName}/${path.basename(file.path)}`; links[relative] = await link(source, relative);
      }
    }
  }
  const nativeFiles = selected.flatMap(item => plan.apiMode ? item.files : plan.compatibility?.[item.id]?.files || item.files).filter(file => file.format === 'macho');
  const libraryPaths = [...new Set(nativeFiles.map(file => path.dirname(fs.realpathSync(file.path))))];
  const frameworkPaths = [...new Set(nativeFiles.flatMap(file => {
    const index = file.path.indexOf('.framework/'); return index < 0 ? [] : [path.dirname(file.path.slice(0, index + 10))];
  }))];
  const record = path.join(root, 'prepared.json'), text = JSON.stringify({ inputs: inputs.flatMap(([, files]) => files.map(([path, sha256]) => ({ path, sha256 }))) }) + '\n';
  if (!fs.existsSync(record) || fs.readFileSync(record, 'utf8') !== text) Writable.atomicWrite(record, text, { root });
  return { root, identity, links, native, dllOverrides: [...new Set(dllOverrides)], env, libraryPaths, frameworkPaths };
  } catch (error) {
    if (error !== stale) throw error;
    warn(logger, `[translators] ${error.message} Preparing another shared generation; the old view is retained.`);
    return prepareTranslatorFiles(plan, { userDataDir, layout, signal, logger }, identity);
  }
}
async function applyNativeLibraries(view, prefixPath, { signal } = {}) {
  const ledgerPath = path.join(prefixPath, '.maclauncher-translators.json');
  let previous = {}; try { previous = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!view.native.length && !Object.keys(previous).length) return;
  const selected = new Set(view.native.map(file => `${file.machine === requiredMachine('x86') ? 'syswow64' : 'system32'}/${file.name}`)), next = {};
  for (const [relative, record] of Object.entries(previous)) {
    if (!/^(?:system32|syswow64)\/[^/\\]+\.dll$/i.test(relative)) throw new Error('The prefix translator record has an invalid file path.');
    if (selected.has(relative)) { next[relative] = record; continue; }
    const destination = path.join(prefixPath, 'drive_c/windows', relative);
    Writable.assertOwnDirectory(prefixPath, path.dirname(destination));
    const current = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (current?.isSymbolicLink() && fs.readlinkSync(destination) === record.target) {
      await fs.promises.unlink(destination);
      if (record.backup && path.basename(record.backup) === record.backup) await fs.promises.rename(path.join(path.dirname(destination), record.backup), destination);
    }
  }
  for (const file of view.native) {
    signal?.throwIfAborted();
    const directory = path.join(prefixPath, 'drive_c/windows', file.machine === requiredMachine('x86') ? 'syswow64' : 'system32');
    Writable.assertOwnDirectory(prefixPath, directory);
    const destination = path.join(directory, file.name);
    const current = await fs.promises.lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    const relative = `${path.basename(directory)}/${file.name}`;
    let backup = previous[relative]?.backup || null;
    if (current?.isSymbolicLink() && fs.readlinkSync(destination) === file.source) { next[relative] = { target: file.source, backup }; continue; }
    if (current) {
      if (previous[relative] && current.isSymbolicLink() && fs.readlinkSync(destination) === previous[relative].target) await fs.promises.unlink(destination);
      else {
        // Preserve user replacements too; a prefix file is never discarded.
        backup = `.${file.name}.maclauncher-original-${crypto.randomUUID()}`;
        await fs.promises.rename(destination, path.join(directory, backup));
      }
    }
    await fs.promises.symlink(file.source, destination);
    next[relative] = { target: file.source, backup };
  }
  Writable.atomicWrite(ledgerPath, JSON.stringify(next) + '\n', { root: prefixPath });
}
module.exports = { selectedDescriptions, filesIdentity, prepareTranslatorFiles, applyNativeLibraries, cpuFolder };
