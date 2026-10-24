const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Python = require('../scripts/python-resources.cjs');
const profile = require('../src/modules/shared/runtime/embedded-python.json');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'python-resources-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const sourceRoot = path.join(parent, 'source'), resourceRoot = path.join(parent, 'app');
  for (const root of [sourceRoot, resourceRoot]) {
    for (const file of [...Python.requiredFiles, 'bin/python3', ...Object.keys(Python.configuration().aliases)]) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.startsWith('bin/') ? 'same upstream interpreter' : 'runtime module', { mode: 0o755 });
    }
    fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify(profile));
  }
  return { parent, sourceRoot, resourceRoot };
}

test('Python app aliases retain one regular interpreter and leave producer copies unchanged', t => {
  const options = fixture(t), before = Python.verifySourcePython(options);
  Python.projectPackagedPython(options);
  for (const [alias, target] of Object.entries(Python.configuration().aliases)) {
    assert.equal(fs.readlinkSync(path.join(options.resourceRoot, alias)), target);
    assert.equal(fs.lstatSync(path.join(options.sourceRoot, alias)).isFile(), true);
  }
  assert.deepEqual(Python.verifySourcePython(options), before);
  // Code signing may change canonical bytes after projection. Layout checks
  // accept the signed executable while preserving the pinned runtime profile.
  fs.appendFileSync(path.join(options.resourceRoot, 'bin/python3'), ' signed app');
  assert.doesNotThrow(() => Python.assertPackagedPython(options));
  fs.rmSync(options.sourceRoot, { recursive: true });
  assert.match(fs.readFileSync(path.join(options.resourceRoot, 'bin/python'), 'utf8'), /signed app/);
});

test('Python projection refuses changed producers or app copies before replacing aliases', t => {
  const options = fixture(t), alias = path.join(options.resourceRoot, 'bin/python');
  fs.appendFileSync(path.join(options.sourceRoot, 'bin/python3.12'), ' changed');
  assert.throws(() => Python.projectPackagedPython(options), /aliases differ/);
  assert.equal(fs.lstatSync(alias).isFile(), true);
  fs.copyFileSync(path.join(options.sourceRoot, 'bin/python3'), path.join(options.sourceRoot, 'bin/python3.12'));
  fs.appendFileSync(path.join(options.resourceRoot, 'bin/python3'), ' changed');
  assert.throws(() => Python.projectPackagedPython(options), /changed before signing/);
  assert.equal(fs.lstatSync(alias).isFile(), true);
});

test('Python projection rejects shared directories and redirected alias destinations', t => {
  const options = fixture(t);
  assert.throws(() => Python.projectPackagedPython({ ...options, resourceRoot: options.sourceRoot }), /separate/);
  fs.rmSync(path.join(options.resourceRoot, 'bin'), { recursive: true });
  fs.symlinkSync(path.join(options.sourceRoot, 'bin'), path.join(options.resourceRoot, 'bin'));
  assert.throws(() => Python.projectPackagedPython(options), /real resource directory/);
  assert.equal(fs.lstatSync(path.join(options.sourceRoot, 'bin/python')).isFile(), true);
});

test('Python post-sign validation rejects escaped aliases, wrong pins and omitted module closure', t => {
  const options = fixture(t); Python.projectPackagedPython(options);
  const alias = path.join(options.resourceRoot, 'bin/python');
  fs.unlinkSync(alias); fs.symlinkSync('../../source/bin/python3', alias);
  assert.throws(() => Python.assertPackagedPython(options), /escapes or duplicates/);
  fs.unlinkSync(alias); fs.symlinkSync('python3', alias);
  fs.writeFileSync(path.join(options.resourceRoot, 'runtime.json'), JSON.stringify({ ...profile, sha256: 'different' }));
  assert.throws(() => Python.assertPackagedPython(options), /pinned profile/);
  fs.writeFileSync(path.join(options.resourceRoot, 'runtime.json'), JSON.stringify(profile));
  fs.unlinkSync(path.join(options.resourceRoot, Python.requiredFiles.at(-1)));
  assert.throws(() => Python.assertPackagedPython(options), /ENOENT/);
});

test('Python app selection excludes installation, SDK and demo files while preserving runtime APIs and licenses', t => {
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const options = fixture(t), matcher = new FileMatcher(options.sourceRoot, '/app', value => value,
    ['python/**', ...Python.resourceExclusions()]).createFilter();
  const selected = file => matcher(path.join(options.sourceRoot, 'python', file), { isDirectory: () => false });
  for (const file of ['bin/python', 'bin/python3.12', 'include/python3.12/Python.h', 'lib/libpython3.12.dylib',
    'lib/python3.12/config-3.12-darwin/python.o',
    'lib/python3.12/site-packages/pip/_vendor/distlib/t64.exe', 'lib/python3.12/site-packages/pip-25.0.1.dist-info/METADATA',
    'lib/python3.12/ensurepip/_bundled/pip.whl', 'lib/python3.12/turtledemo/clock.py', 'lib/tcl9/9.0/tcltest-2.5.11.tm'])
    assert.equal(selected(file), false, file);
  for (const file of ['bin/python3', 'LICENSE', 'lib/python3.12/ctypes/__init__.py', 'lib/python3.12/venv/__init__.py',
    'lib/python3.12/unittest/__init__.py', 'lib/python3.12/tkinter/__init__.py', 'lib/libtcl9.0.dylib',
    'lib/python3.12/site-packages/packaging/licenses/__init__.py']) assert.equal(selected(file), true, file);
  Python.projectPackagedPython(options);
  const unwanted = path.join(options.resourceRoot, 'lib/python3.12/turtledemo/clock.py');
  fs.mkdirSync(path.dirname(unwanted), { recursive: true }); fs.writeFileSync(unwanted, 'demo');
  assert.throws(() => Python.assertPackagedPython(options), /demonstration resource/);
});
