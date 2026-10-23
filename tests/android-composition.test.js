'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertComposition } = require('./helpers/android-composition');

function fixture() {
  const universe = { components: [
    { id: 'framework', revision: 'original-16', dependencies: ['native-window'], javaMembers: ['android.view.Surface#<init>()V', 'android.view.Surface#release()V'] },
    { id: 'native-window', revision: 'original-16', dependencies: ['linux-buffer-device'], exports: ['ANativeWindow_acquire', 'ANativeWindow_release'] },
    { id: 'linux-buffer-device', revision: 'original-16' },
    { id: 'darwin-buffer', revision: 'owned-1' },
    { id: 'kernel-tests', revision: 'original-16' }
  ], javaMembers: ['android.view.Surface#<init>()V', 'android.view.Surface#release()V'] };
  const decisions = [
    { id: 'framework', include: true, supplier: 'framework-jar', reason: 'Complete original executable classes.', action: 'Retain unchanged bodies.' },
    { id: 'native-window', include: true, supplier: 'platform-native', reason: 'Complete original NDK client.', action: 'Bind the Darwin producer below the original API.', dependencies: { 'linux-buffer-device': 'darwin-buffer' }, boundaries: [{ dependency: 'linux-buffer-device', owner: 'darwin-buffer', reason: 'Linux device allocation is replaced by the actual IOSurface owner.' }] },
    { id: 'linux-buffer-device', include: false, reason: 'Linux device mechanism cannot own a Darwin buffer.', action: 'Use the explicit Darwin allocation boundary.' },
    { id: 'darwin-buffer', include: true, supplier: 'platform-native', reason: 'Actual Mac producer/storage allocation.', action: 'Retain one shared buffer owner.', owns: ['graphics-buffer-allocation'] },
    { id: 'kernel-tests', include: false, reason: 'Kernel conformance executable, not runtime implementation.', action: 'Developer testing only.' }
  ];
  const jar = { path: 'framework.jar', sha256: 'a'.repeat(64) }, native = { path: 'native.dylib', sha256: 'b'.repeat(64) };
  const suppliers = [
    { id: 'framework-jar', products: [jar], components: [{ id: 'framework', revision: 'original-16', products: [jar], javaMembers: [...universe.javaMembers] }] },
    { id: 'platform-native', products: [native], components: [
      { id: 'native-window', revision: 'original-16', products: [native], exports: ['ANativeWindow_acquire', 'ANativeWindow_release'] },
      { id: 'darwin-buffer', revision: 'owned-1', products: [native] }
    ] }
  ];
  return { universe, decisions, suppliers };
}
const check = ({ universe, decisions, suppliers }) => assertComposition(universe, decisions, suppliers);
test('Component composition retains original APIs and resolves real platform mechanisms to one owner', () => check(fixture()));
const mutations = [
  ['forgotten project', f => f.decisions.pop(), /Missing decision: kernel-tests/],
  ['unexamined marked unresolved', f => f.decisions[0].include = null, /Unresolved decision: framework/],
  ['unknown automatic candidate', f => f.decisions.push({ id: 'invented', include: false }), /Unknown decision: invented/],
  ['missing dependency implementation', f => f.decisions[3].include = false, /Dependency has no included owner/],
  ['unjustified dependency replacement', f => f.decisions[1].boundaries = [], /substitution lacks boundary/],
  ['omitted native export', f => f.suppliers[1].components[0].exports.pop(), /Missing export.*ANativeWindow_release/],
  ['omitted Java member', f => f.suppliers[0].components[0].javaMembers.pop(), /Original Java baseline omitted/],
  ['unpackaged component product', f => f.suppliers[1].products = [], /Missing or changed product/],
  ['substituted binary product', f => f.suppliers[1].products = [{ path: 'native.dylib', sha256: 'other' }], /Missing or changed product/],
  ['missing checksum on both sides', f => { delete f.suppliers[1].products[0].sha256; }, /Invalid product identity/],
  ['wrong source revision', f => f.suppliers[1].components[0].revision = 'different', /revision mismatch/],
  ['second buffer owner', f => f.decisions[1].owns = ['graphics-buffer-allocation'], /Competing resource owners/]
];
for (const [name, mutate, expected] of mutations) test('Component reconciliation rejects ' + name, () => {
  const f = fixture(); mutate(f); assert.throws(() => check(f), expected);
});

test('Native evidence reads linked artifacts and detects a removed real dependency without filename selection', { skip: process.platform !== 'darwin' }, () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { nativeArtifactEvidence } = require('./helpers/android-composition');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-composition-'));
  try {
    fs.writeFileSync(path.join(root, 'provider.c'), 'int original_component(void) { return 42; }\n');
    fs.writeFileSync(path.join(root, 'client.c'), 'extern int original_component(void); int original_client(void) { return original_component(); }\n');
    execFileSync('clang', ['-dynamiclib', path.join(root, 'provider.c'), '-Wl,-install_name,@rpath/Provider', '-o', path.join(root, 'Provider')]);
    execFileSync('clang', ['-dynamiclib', path.join(root, 'client.c'), path.join(root, 'Provider'), '-Wl,-install_name,@rpath/Client', '-Wl,-rpath,@loader_path', '-o', path.join(root, 'Client')]);
    const products = ['Provider', 'Client'].map(file => ({ path: file, sha256: require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
    const result = nativeArtifactEvidence(root, products);
    assert.deepEqual(result.problems, []);
    assert.equal(result.artifacts.length, 2);
    assert.ok(result.artifacts.find(a => a.path === 'Provider').symbols.includes('original_component'));
    assert.equal(result.artifacts.find(a => a.path === 'Client').dependencies.find(d => d.link === '@rpath/Provider').owner, 'Provider');
    fs.unlinkSync(path.join(root, 'Provider'));
    assert.ok(nativeArtifactEvidence(root, products).problems.some(p => /Client -> @rpath\/Provider/.test(p)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
