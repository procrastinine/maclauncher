const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const PE = require('../src/modules/shared/runtime/pe-exports');
const Description = require('../src/modules/shared/runtime/translator-description');
const Component = require('../src/modules/shared/runtime/component-runtime');
const { peFixture } = require('./helpers/pe-fixture');

function fixture(t, name, bytes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-imports-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, name); fs.writeFileSync(file, bytes); return { root, file };
}
function importing(names, { is64 = true } = {}) {
  const f = peFixture({ is64 }), start = 0x800, width = is64 ? 8 : 4;
  f.bytes.writeUInt16LE(0x2002, f.peOffset + 22); f.bytes.write('Wine builtin DLL\0', 64);
  if (!names.length) return f;
  const rva = offset => 0x2000 + offset;
  let next = start + (names.length + 1) * 20;
  f.bytes.writeUInt32LE(rva(start), f.directories + 8); f.bytes.writeUInt32LE((names.length + 1) * 20, f.directories + 12);
  names.forEach((name, index) => {
    const descriptor = f.raw + start + index * 20, lookup = next, iat = next + width * 2;
    next += width * 4;
    f.bytes.writeUInt32LE(rva(lookup), descriptor); f.bytes.writeUInt32LE(rva(iat), descriptor + 16);
    f.bytes.writeUInt32LE(rva(next), descriptor + 12);
    f.bytes.write(name + '\0', f.raw + next); next += Buffer.byteLength(name) + 1;
    for (const offset of [lookup, iat]) {
      if (is64) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + offset);
      else f.bytes.writeUInt32LE(0x80000001, f.raw + offset);
    }
  });
  return { ...f, importStart: start };
}

test('Direct3D PE imports report actual DXGI and thunk dependencies without inventing D3D9 companions', t => {
  const nine = fixture(t, 'd3d9.dll', importing([]).bytes), eleven = fixture(t, 'd3d11.dll', importing(['DXGI.dll', 'winemetal.dll', 'KERNEL32.dll']).bytes);
  const noCompanions = Description.inspectFile({ path: nine.file }), companions = Description.inspectFile({ path: eleven.file });
  assert.deepEqual(noCompanions.peImports, []); assert.equal(noCompanions.importsComplete, true);
  assert.deepEqual(companions.peImports, ['dxgi.dll', 'winemetal.dll', 'kernel32.dll']); assert.equal(companions.importsComplete, true);
  assert.equal(companions.machine, 0x8664); assert.equal(companions.form, 'builtin');
  const ordinary = PE.readPeExports(eleven.file);
  assert.equal(ordinary.exports.size, 0); assert.equal(Object.hasOwn(ordinary, 'peImports'), false);
  assert.equal(Object.hasOwn(ordinary, 'importsComplete'), false);
  assert.deepEqual(PE.readPeExports(eleven.file, { headersOnly: true, imports: true }).peImports, companions.peImports);
  const thirtyTwo = fixture(t, 'd3d9.dll', importing(['DXGI.dll'], { is64: false }).bytes);
  assert.equal(Description.inspectFile({ path: thirtyTwo.file }).machine, 0x14c);
  assert.deepEqual(Description.inspectFile({ path: thirtyTwo.file }).peImports, ['dxgi.dll']);
});

test('incomplete optional import tables retain valid PE facts and registration with a warning', t => {
  for (const malformed of ['missing terminator', 'unbacked name', 'bounded name']) {
    const f = importing(['dxgi.dll']);
    if (malformed === 'missing terminator') f.bytes.writeUInt32LE(20, f.directories + 12);
    if (malformed === 'unbacked name') f.bytes.writeUInt32LE(0xffffffff, f.raw + f.importStart + 12);
    if (malformed === 'bounded name') {
      const nameRva = f.bytes.readUInt32LE(f.raw + f.importStart + 12), name = f.raw + nameRva - 0x2000;
      f.bytes.fill(0x61, name, name + PE.LIMITS.nameBytes + 1); f.bytes[name + PE.LIMITS.nameBytes + 1] = 0;
    }
    const selected = fixture(t, 'd3d11.dll', f.bytes), messages = [];
    const facts = Description.inspectFile({ path: selected.file });
    assert.equal(facts.format, 'pe', malformed); assert.equal(facts.architecture, 'x86_64'); assert.equal(facts.importsComplete, false);
    assert.match(facts.inspectionWarning, /PE import inspection is incomplete/);
    assert.equal(PE.readPeExports(selected.file).exports.size, 0, 'ordinary export reading does not inspect imports');
    const registration = Component.inspected(selected.root, { engine: 'dxmt' }, { logger: { warn: message => messages.push(message) } });
    assert.equal(registration.translator.files[0].format, 'pe'); assert.ok(messages.some(message => /import inspection is incomplete/.test(message)));
  }
});

test('header-only recovery after optional export exhaustion retains direct PE import facts', t => {
  const f = importing(['dxgi.dll', 'winemetal.dll']), exportOffset = 0x1000, exportSize = PE.LIMITS.exportBytes + 1;
  const bytes = Buffer.alloc(f.raw + exportOffset + exportSize); f.bytes.copy(bytes);
  bytes.writeUInt32LE(bytes.length - f.raw, f.section + 8); bytes.writeUInt32LE(bytes.length - f.raw, f.section + 16);
  bytes.writeUInt32LE(0x2000 + exportOffset, f.directories); bytes.writeUInt32LE(exportSize, f.directories + 4);
  const selected = fixture(t, 'd3d11.dll', bytes);
  assert.equal(PE.readPeExports(selected.file, { imports: true }), null);
  const basic = PE.readPeExports(selected.file, { headersOnly: true, imports: true });
  assert.deepEqual(basic.peImports, ['dxgi.dll', 'winemetal.dll']); assert.equal(basic.importsComplete, true);
  const inspected = Description.inspectFile({ path: selected.file });
  assert.equal(inspected.format, 'pe'); assert.equal(inspected.importsComplete, true);
  assert.deepEqual(inspected.peImports, basic.peImports); assert.match(inspected.inspectionWarning, /export inspection is incomplete/);
});

test('declared delay imports retain direct facts and mark companion scope incomplete without a second parser', t => {
  const f = importing(['dxgi.dll']), start = 0xc00, name = start + 64, lookup = start + 96, iat = lookup + 16, handle = iat + 16;
  f.bytes.writeUInt32LE(0x2000 + start, f.directories + 13 * 8); f.bytes.writeUInt32LE(64, f.directories + 13 * 8 + 4);
  for (const [offset, value] of [[0, 1], [4, 0x2000 + name], [8, 0x2000 + handle], [12, 0x2000 + iat], [16, 0x2000 + lookup]]) f.bytes.writeUInt32LE(value, f.raw + start + offset);
  f.bytes.write('winemetal.dll\0', f.raw + name);
  for (const offset of [lookup, iat]) f.bytes.writeBigUInt64LE(0x8000000000000001n, f.raw + offset);
  const selected = fixture(t, 'd3d11.dll', f.bytes), facts = Description.inspectFile({ path: selected.file });
  assert.deepEqual(facts.peImports, ['dxgi.dll']); assert.equal(facts.importsComplete, false);
  assert.match(facts.inspectionWarning, /delay-import directory/);
  assert.equal(Component.inspected(selected.root, { engine: 'dxmt' }, { logger: { warn() {} } }).translator.files[0].format, 'pe');
});

test('invalid actual PE headers do not become libraries through optional import recovery', t => {
  const selected = fixture(t, 'd3d11.dll', importing(['dxgi.dll']).bytes);
  fs.truncateSync(selected.file, 128);
  assert.equal(PE.readPeExports(selected.file, { imports: true }), null);
  assert.equal(PE.readPeExports(selected.file, { headersOnly: true, imports: true }), null);
  assert.equal(Description.inspectFile({ path: selected.file }).format, 'unknown');
  assert.throws(() => Component.inspected(selected.root, { engine: 'dxmt' }, { logger: { warn() {} } }), /no loadable library/);
});
