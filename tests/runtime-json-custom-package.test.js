const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Bundled = require('../src/modules/shared/runtime/bundled-native');
const Custom = require('../src/modules/shared/runtime/custom-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-json-custom-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  t.mock.method(Bundled, 'systemVersionSync', () => '99.0');
  const executable = Buffer.alloc(32);
  executable.writeUInt32LE(0xfeedfacf); executable.writeUInt32LE(0x0100000c, 4); executable.writeUInt32LE(2, 12);
  const payload = path.join(root, 'files');
  const bin = path.join(payload, 'bin', 'runner'); fs.mkdirSync(path.dirname(bin), {recursive:true});
  fs.writeFileSync(bin, executable, {mode: 0o755});
  fs.writeFileSync(path.join(payload, 'companion.dat'), 'complete payload');
  const file = (name, mode) => {const bytes=fs.readFileSync(path.join(payload,name));return {path:name,mode,size:bytes.length,sha256:Bundled.digest(bytes)};};
  const manifest = {schemaVersion:1,managerId:'package-test',version:'1.0',platform:'darwin',arch:'arm64',minimumMacOS:'13.0',
    upstreamRevision:'a'.repeat(40),executableRelative:'bin/runner',dependencies:[],
    files:[{...file('bin/runner',0o755),architectures:['arm64']},file('companion.dat',0o644)]};
  fs.writeFileSync(path.join(root,'runtime.json'),JSON.stringify(manifest));
  return {root,payload,bin,manifest};
}

test('custom runtime.json packages are inspected from their directory and executable', t => {
  const f = fixture(t);
  for(const selected of [f.root,f.bin]) {
    const install = Custom.inspectManifest(selected,{managerId:'package-test'});
    assert.ok(install,'the package manifest is used instead of a bare executable');
    assert.equal(install.root,f.payload);
    assert.equal(install.runtimeVersion,'1.0');
    assert.deepEqual(install.architectures,['arm64']);
  }
});

test('runtime.json custom inspection retains full closure and actual CPU checks', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.payload,'companion.dat'),'modified payload');
  assert.throws(()=>Custom.inspectManifest(f.root,{managerId:'package-test'}),/checksum|size|permissions/);
  fs.writeFileSync(path.join(f.payload,'companion.dat'),'complete payload');
  const bytes=fs.readFileSync(f.bin); bytes.writeUInt32LE(0x01000007,4); fs.writeFileSync(f.bin,bytes);
  f.manifest.files[0].sha256=Bundled.digest(bytes);
  fs.writeFileSync(path.join(f.root,'runtime.json'),JSON.stringify(f.manifest));
  assert.throws(()=>Custom.inspectManifest(f.root,{managerId:'package-test'}),/architecture/);
});
