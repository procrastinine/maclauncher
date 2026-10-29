const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const Host = require('../scripts/app-host.cjs');
const ROOT = path.resolve(__dirname, '..');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  Object.defineProperty(process.versions, 'electron', { value: '44.9.3', configurable: true });
  assert.equal(Binary.resolveElectronBinary(), process.execPath);
});

test('Electron publisher comparison rejects changed source, modes, extra members and escaping aliases', t => {
  const root = temporary(t), app = path.join(root, 'Electron.app'); fs.mkdirSync(path.join(app, 'Contents'), {recursive:true});
  const file = path.join(app, 'Contents/file'); fs.writeFileSync(file, 'source', {mode:0o644}); fs.symlinkSync('file', path.join(app, 'Contents/alias'));
  const inventory = { files: [{path:'Contents/file',type:'file',size:6,mode:0o644,sha256:hash(file)}, {path:'Contents/alias',type:'symlink',target:'file'}] };
  assert.equal(Host.verifyElectronApp(app, inventory).files, 2);
  fs.writeFileSync(file, 'change'); assert.throws(() => Host.verifyElectronApp(app, inventory), /differs from its publisher/);
  fs.writeFileSync(file, 'source'); fs.chmodSync(file, 0o755); assert.throws(() => Host.verifyElectronApp(app, inventory), /differs from its publisher/);
  fs.chmodSync(file, 0o644); fs.writeFileSync(path.join(app, 'Contents/extra'), 'extra');
  assert.throws(() => Host.verifyElectronApp(app, inventory), /unlisted app member/); fs.rmSync(path.join(app, 'Contents/extra'));
  fs.writeFileSync(path.join(root, 'outside'), 'keep'); fs.rmSync(path.join(app, 'Contents/alias')); fs.symlinkSync('../../outside', path.join(app, 'Contents/alias'));
  assert.throws(() => Host.verifyElectronApp(app, {files:[inventory.files[0], {...inventory.files[1],target:'../../outside'}]}), /alias differs/);
  assert.equal(fs.readFileSync(path.join(root, 'outside'),'utf8'),'keep');
});

test('app input gate traces installed Electron to its npm identity and original publisher ZIP', {skip:process.platform!=='darwin'}, t => {
  const selected = Host.readHost({repoRoot:ROOT}), original = path.join(ROOT, Host.sourceAppRelative(selected.record));
  assert.equal(selected.record.id,'electron');
  assert.equal(selected.record.version,require('electron/package.json').version);
  assert.match(selected.record.asset.url,/^https:\/\/github.com\/electron\/electron\/releases\/download\//);
  assert.match(selected.record.npm.integrity,/^sha512-/);
  assert.equal(Host.verifyElectronApp(original,selected.inventory).files,selected.inventory.files.length);
  const sources = require('../scripts/app-inputs.cjs').hostSources(ROOT,require('../package.json'));
  assert.equal(sources.files.size+sources.aliases.size,selected.inventory.files.length+selected.inventory.notices.length);
  assert.equal(sources.files.get('Contents/Resources/LICENSE.electron.txt').sha256,hash(path.join(ROOT,'node_modules/electron/dist/LICENSE')));
  assert.equal(sources.files.get('Contents/Resources/LICENSES.chromium.html').sha256,hash(path.join(ROOT,'node_modules/electron/dist/LICENSES.chromium.html')));
  assert.equal(sources.files.get('Contents/MacOS/Electron').owner,'upstream-host');
  const root = temporary(t), corrupt = path.join(root,'modified.zip');fs.writeFileSync(corrupt,'modified');
  assert.throws(()=>Host.readHost({repoRoot:ROOT,archivePath:corrupt}),/publisher checksum/);
});
