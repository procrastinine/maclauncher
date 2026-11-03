const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const Writable = require('../shared/writable-input');
const { getUiServices } = require('../shared/ui-services');
const FILE = '0x52_URM.rpa';
function assertArchive(file) {
  const fd = fs.openSync(file, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Universal Ren\'Py Mod requires an RPA file.');
    const bytes = Buffer.alloc(256), size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (!/^RPA-\d+\.\d+[ \t]+[0-9a-f]+(?:[ \t]+[0-9a-f]+)*\r?\n/i.test(bytes.toString('ascii', 0, size)))
      throw new Error('The selected file is not an RPA archive.');
  } finally { fs.closeSync(fd); }
}
async function resolve(context = {}, { choose = false, filePaths } = {}) {
  if (!path.isAbsolute(context.userDataDir || '')) throw new Error('Universal Ren\'Py Mod requires launcher storage.');
  const directory = path.join(context.userDataDir, 'renpy', 'user-tools', 'universal-mod');
  const remembered = path.join(directory, FILE);
  if (!choose && fs.existsSync(remembered)) {
    Writable.assertOwnDirectory(context.userDataDir, directory, {create:false});
    if (!fs.lstatSync(remembered).isFile()) throw new Error('The remembered Mod must be a regular RPA file.');
    assertArchive(remembered); return remembered;
  }
  const result = filePaths ? { filePaths } : await getUiServices(context).dialog.showOpenDialog({
    title: "Choose Universal Ren'Py Mod file", message: 'Select a supplied 0x52_URM.rpa file. A private copy is kept for later installations.',
    properties: ['openFile'], filters: [{ name: "Ren'Py archive", extensions: ['rpa'] }]
  });
  if (result.canceled || !result.filePaths?.length) return null;
  const source = result.filePaths[0]; assertArchive(source);
  Writable.assertOwnDirectory(context.userDataDir, directory);
  const temporary = path.join(directory, '.urm-' + crypto.randomUUID());
  try {
    Writable.atomicCopy(source, temporary, {root:context.userDataDir, preserveTimes:false});
    assertArchive(temporary); fs.chmodSync(temporary,0o600); fs.renameSync(temporary,remembered);
  } finally { fs.rmSync(temporary,{force:true}); }
  return remembered;
}
module.exports = { resolve };
