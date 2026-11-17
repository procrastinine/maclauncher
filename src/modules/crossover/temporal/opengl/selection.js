const fs = require('node:fs'), path = require('node:path');
const { fileDigest } = require('../../../shared/runtime/verified-identity');
const { readPeExports } = require('../../../shared/runtime/pe-exports');

// The graphics helper package declares this pair beside its WineVulkan pair.
// It preserves WineMetalGL's complete forwarding API and opens the graphics
// libraries from its Unix constructor, before the first OpenGL context.
function select(root, manifest, layout, environment = {}) {
  if (environment.OPENGL_BACKEND === 'wine' || String(environment.WINEMETALGL) === '0') return null;
  const declaration = manifest.provider?.opengl32;
  if (!declaration || declaration.graphicsLibraryAPI !== 1 || layout.architecture !== 'arm64') return null;
  const checked = relative => {
    if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('Invalid OpenGL helper path.');
    const row = manifest.files.find(row => row.path === relative), file = path.join(root, relative);
    if (!row || fileDigest(file).sha256 !== row.sha256) throw Error('OpenGL helper changed.');
    return { file, sha256: row.sha256 };
  };
  const native = {...checked(declaration.unix), dependencies: []};
  const clients = declaration.windows.map(relative => {
    const client = checked(relative), windows = path.basename(path.dirname(relative));
    if (!layout.windows.includes(windows) || !fs.existsSync(path.resolve(layout.dllRoot,"../winemetalgl",windows,"opengl32.dll"))) return null;
    const pe = readPeExports(client.file, {exportOrdinals: true});
    if (pe?.form !== 'builtin' || pe.exports.size !== 361 || [...pe.exportOrdinals.values()].some(row =>
      row.names.length !== 1 || row.forwarder?.module !== 'winemetalgl.dll' || row.forwarder.name !== row.names[0])) throw Error('OpenGL helper forwarding API is incomplete.');
    const original = path.join(layout.dllRoot, windows, 'opengl32.dll');
    if (!fs.existsSync(original)) return null;
    return { windows, client: {...client, original: {file: original, sha256: fileDigest(original).sha256}} };
  }).filter(Boolean);
  return clients.length ? {native, clients, graphicsLibraries: true} : null;
}
async function prepare(selection, {prefixPath, dllRoot, layout, signal}) {
  const views = [];
  try {
    for (const pair of selection.clients) views.push(await require('../vulkan/selection').prepareSelection({
      ...pair, native: selection.native, prefixPath, dllRoot: path.join(dllRoot, 'maclauncher-opengl', pair.windows), unixName: layout.unixName, signal, dll: 'opengl32'}));
  } catch (error) { for (const view of views.reverse()) await view.restore(); throw error; }
  return {
    env: {WINEDLLPATH: views.map(view => view.env.WINEDLLPATH).join(path.delimiter), WINEDLLOVERRIDES: 'opengl32=b'},
    async applyPrefix() { try { for (const view of views) await view.applyPrefix(); } catch (error) { for (const view of views.toReversed()) await view.restore(); throw error; } },
    async restore() { for (const view of views.toReversed()) await view.restore(); },
  };
}
module.exports = {select, prepare};
