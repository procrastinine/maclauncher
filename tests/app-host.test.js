const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const Host = require('../scripts/app-host.cjs');
const ROOT = path.resolve(__dirname, '..');
function temporary(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-supplier-')); t.after(() => fs.rmSync(root, {recursive:true,force:true})); return root; }

test('Node resolves the installed upstream Electron without loading its downloading entry point', t => {
  const Binary = require('../src/core/electron-binary');
  const previous = process.env.MACLAUNCHER_ELECTRON_PATH, electron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  t.after(() => { if (previous === undefined) delete process.env.MACLAUNCHER_ELECTRON_PATH; else process.env.MACLAUNCHER_ELECTRON_PATH = previous;
    if (electron) Object.defineProperty(process.versions, 'electron', electron); else delete process.versions.electron; });
  delete process.env.MACLAUNCHER_ELECTRON_PATH; delete process.versions.electron;
  const metadata = require.resolve('electron/package.json'), directory = path.dirname(metadata);
  const relative = fs.readFileSync(path.join(directory, 'path.txt'), 'utf8').trim();
  const original = path.join(directory, 'dist', relative);
  assert.equal(Binary.resolveElectronBinary(), original);
  assert.equal(require.cache[require.resolve('electron')], undefined);
  process.env.MACLAUNCHER_ELECTRON_PATH = ' /explicit/Electron ';
  assert.equal(Binary.resolveElectronBinary(), '/explicit/Electron');
  delete process.env.MACLAUNCHER_ELECTRON_PATH;
  Object.defineProperty(process.versions, 'electron', { value: '45.0.0', configurable: true });
  assert.equal(Binary.resolveElectronBinary(), process.execPath);
});

test('Electron input archive follows its exact npm publisher identity and digest', {skip:process.platform!=='darwin'}, t => {
  const selected = Host.readHost({repoRoot:ROOT});
  assert.equal(selected.record.id,'electron');
  assert.equal(selected.record.version,require('electron/package.json').version);
  assert.match(selected.record.asset.url,/^https:\/\/github.com\/electron\/electron\/releases\/download\//);
  assert.match(selected.record.npm.integrity,/^sha512-/);
  const root = temporary(t), corrupt = path.join(root,'modified.zip');fs.writeFileSync(corrupt,'modified');
  assert.throws(()=>Host.readHost({repoRoot:ROOT,archivePath:corrupt}),/publisher checksum/);
});
