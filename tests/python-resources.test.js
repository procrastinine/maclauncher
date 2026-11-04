const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Python = require('../scripts/python-resources.cjs');
const profile = require('../src/modules/shared/runtime/python').embeddedPythonProfile('arm64');

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'python-resources-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const sourceRoot = path.join(parent, 'source'), resourceRoot = path.join(parent, 'app');
  for (const root of [sourceRoot, resourceRoot]) {
    for (const file of ['lib/python3.12/encodings/__init__.py', 'bin/python3', ...Object.keys(Python.configuration().aliases)]) {
      const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.startsWith('bin/') ? 'same upstream interpreter' : 'runtime module', { mode: 0o755 });
    }
    fs.writeFileSync(path.join(root, 'runtime.json'), JSON.stringify(profile));
  }
  return { parent, sourceRoot, resourceRoot, arch: 'arm64' };
}

test('Python app aliases retain one regular interpreter and leave producer copies unchanged', t => {
  const options = fixture(t), sourceFiles = ['bin/python3', ...Object.keys(Python.configuration().aliases)];
  const before = sourceFiles.map(file => fs.readFileSync(path.join(options.sourceRoot, file)));
  Python.projectPackagedPython(options);
  for (const [alias, target] of Object.entries(Python.configuration().aliases)) {
    assert.equal(fs.readlinkSync(path.join(options.resourceRoot, alias)), target);
    assert.equal(fs.lstatSync(path.join(options.sourceRoot, alias)).isFile(), true);
  }
  assert.deepEqual(sourceFiles.map(file => fs.readFileSync(path.join(options.sourceRoot, file))), before);
  // Aliases keep using the signed interpreter without another copy.
  fs.appendFileSync(path.join(options.resourceRoot, 'bin/python3'), ' signed app');
  Python.projectPackagedPython(options);
  fs.rmSync(options.sourceRoot, { recursive: true });
  assert.match(fs.readFileSync(path.join(options.resourceRoot, 'bin/python'), 'utf8'), /signed app/);
});

test('Python projection rejects shared directories and redirected alias destinations', t => {
  const options = fixture(t);
  assert.throws(() => Python.projectPackagedPython({ ...options, resourceRoot: options.sourceRoot }), /separate/);
  fs.rmSync(path.join(options.resourceRoot, 'bin'), { recursive: true });
  fs.symlinkSync(path.join(options.sourceRoot, 'bin'), path.join(options.resourceRoot, 'bin'));
  assert.throws(() => Python.projectPackagedPython(options), /real resource directory/);
  assert.equal(fs.lstatSync(path.join(options.sourceRoot, 'bin/python')).isFile(), true);
});

test('Python publisher input metadata retains the selected pinned profile', () => {
  assert.deepEqual(Python.assertProfile(profile, 'arm64'), profile);
  assert.throws(() => Python.assertProfile({...profile, sha256: 'different'}, 'arm64'), /pinned profile/);
  assert.throws(() => Python.assertProfile(profile, 'x64'), /not the x64 build/);
});

test('Python app selection excludes installation, SDK and demo files while preserving runtime APIs and licenses', t => {
  const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const options = fixture(t), matcher = new FileMatcher(options.sourceRoot, '/app', value => value,
    ['python/**', ...Python.resourceExclusions()]).createFilter();
  const selected = file => matcher(path.join(options.sourceRoot, 'python', file), { isDirectory: () => false });
  for (const file of ['bin/python', 'bin/python3.12', 'include/python3.12/Python.h', 'lib/libpython3.12.dylib',
    'lib/python3.12/config-3.12-darwin/python.o',
    'lib/python3.12/site-packages/pip/_vendor/distlib/t64.exe', 'lib/python3.12/site-packages/pip-25.0.1.dist-info/METADATA',
    'lib/python3.12/ensurepip/_bundled/pip.whl', 'lib/python3.12/turtledemo/clock.py', 'lib/tcl9/9.0/tcltest-2.5.11.tm',
    'lib/libtcl9.0.dylib', 'lib/libtcl9tk9.0.dylib', 'lib/tcl9.0/init.tcl', 'lib/tk9.0/tk.tcl',
    'lib/itcl4.3.8/libtcl9itcl4.3.8.dylib', 'lib/thread3.0.6/libthread3.0.6.dylib',
    'lib/python3.12/tkinter/__init__.py', 'lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so',
    'lib/python3.12/idlelib/__init__.py', 'lib/python3.12/lib2to3/refactor.py', 'lib/python3.12/pydoc_data/topics.py'])
    assert.equal(selected(file), false, file);
  for (const file of ['bin/python3', 'LICENSE', 'lib/python3.12/ctypes/__init__.py', 'lib/python3.12/venv/__init__.py',
    'lib/python3.12/unittest/__init__.py', 'lib/python3.12/threading.py', 'lib/python3.12/pydoc.py',
    'lib/python3.12/site-packages/packaging/licenses/__init__.py']) assert.equal(selected(file), true, file);
});
