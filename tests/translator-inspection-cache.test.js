const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const D = require('../src/modules/shared/runtime/translator-description');
const { peFixture } = require('./helpers/pe-fixture');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'translator-inspection-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pe = peFixture({ is64: true });
  pe.bytes.writeUInt16LE(0x2002, pe.peOffset + 22); pe.bytes.write('Wine builtin DLL\0', 64);
  // A valid library with optional exports too large for that reader's bounds.
  pe.bytes.writeUInt32LE(0x2e00, pe.directories); pe.bytes.writeUInt32LE(40, pe.directories + 4);
  pe.bytes.writeUInt32LE(9000, pe.raw + 0xe00 + 24);
  const file = path.join(root, 'd3d11.dll'); fs.writeFileSync(file, pe.bytes);
  return { root, file, bytes: pe.bytes };
}

test('component inspection reuses unchanged file facts and warns once without sharing mutable inventories', t => {
  const f = fixture(t), warnings = [], descriptors = new Map(); let reads = 0;
  const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
  t.mock.method(fs, 'openSync', (file, ...args) => { const fd = open(file, ...args); descriptors.set(fd, file); return fd; });
  t.mock.method(fs, 'readSync', (fd, ...args) => { if (descriptors.get(fd) === f.file) reads++; return read(fd, ...args); });
  t.mock.method(fs, 'closeSync', fd => { descriptors.delete(fd); return close(fd); });
  const options = { engine: 'dxvk', source: { label: 'Scratch host' }, logger: { warn: message => warnings.push(message) } };
  const first = D.describeTranslator(f.root, options), after = reads;
  assert.ok(after > 0); assert.equal(first.files[0].machine, 0x8664);
  assert.ok(warnings.some(message => /PE export inspection is incomplete/.test(message)));
  const count = warnings.length;
  first.files.length = 0; first.apis.push('caller-only'); first.source.label = 'caller-only';
  const second = D.describeTranslator(f.root, options);
  assert.equal(reads, after); assert.equal(warnings.length, count);
  assert.equal(second.files.length, 1); assert.deepEqual(second.apis, ['Direct3D 11']);
  assert.equal(second.source.label, 'Scratch host'); assert.equal(options.source.label, 'Scratch host');
  const previous = fs.statSync(f.file), changed = Buffer.from(f.bytes); changed[64] = 88;
  fs.writeFileSync(f.file, changed); fs.utimesSync(f.file, previous.atime, previous.mtime);
  assert.equal(D.describeTranslator(f.root, options).files[0].form, 'native');
  assert.ok(reads > after); assert.ok(warnings.length > count);
});

test('component inspection observes newly supplied version metadata and discovered library entries', t => {
  const f = fixture(t), options = { engine: 'dxvk', logger: { warn() {} } };
  assert.equal(D.describeTranslator(f.root, options).version, '');
  fs.writeFileSync(path.join(f.root, 'version'), 'published release');
  const versioned = D.describeTranslator(f.root, options);
  assert.equal(versioned.version, 'published release');
  fs.writeFileSync(path.join(f.root, 'd3d9.dll'), f.bytes);
  const expanded = D.describeTranslator(f.root, options);
  assert.equal(expanded.files.length, 2); assert.ok(expanded.apis.includes('Direct3D 9'));
  fs.unlinkSync(path.join(f.root, 'd3d9.dll'));
  assert.equal(D.describeTranslator(f.root, options).files.length, 1);
});
