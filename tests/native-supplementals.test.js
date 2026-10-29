const assert = require('node:assert/strict');
const test = require('node:test');
const S = require('../scripts/native-supplementals.cjs');
const Modules = require('../src/modules/registry');
const fs = require('node:fs');
const path = require('node:path');

test('registered supplemental declarations have pure module exports and complete pinned inventories', () => {
  const declarations = S.declarations();
  const exported = Modules.listModules().flatMap(info => Modules.getModule(info.id)?.distributionSupplementals || []);
  for (const submodule of Modules.listSharedSubmodules()) {
    const declaration = path.join(submodule.dir, 'distribution-supplementals.json');
    if (fs.existsSync(declaration)) exported.push(...JSON.parse(fs.readFileSync(declaration, 'utf8')));
  }
  assert.deepEqual(declarations, exported);
  assert.ok(declarations.length);
  for (const item of declarations) {
    if (item.sourceRelative) {
      assert.ok(item.files.some(file => file.path === item.sourceRelative && file.sha256 === item.sourceSha256));
    } else {
      const sources = require('../scripts/native-source-artifacts.cjs').requirements([], new Map(), [item]);
      assert.deepEqual(sources, item.sourceArtifact ? [{ managerId: item.id, version: item.version, ...item.sourceArtifact }] : []);
      assert.equal(item.files.some(file => file.path.endsWith('-source.tar.gz')), false);
    }
    assert.ok(item.files.some(file => file.path === item.manifestRelative && file.sha256 === item.manifestSha256));
    if (item.id === 'android-launcher') {
      assert.equal(item.arch, 'universal');
      assert.equal(item.files.some(file => file.architectures), false, 'The owned launcher package contains JVM bytecode and JavaScript, not native code');
      assert.ok(item.files.some(file => file.path.endsWith('.jar')));
      assert.ok(item.files.some(file => file.path.endsWith('.js')));
      require('../src/modules/shared/runtime/bundled-native').verifyPayload(path.resolve(__dirname, '../src/resources/native-runtimes', item.directoryRelative), item);
    } else assert.ok(item.files.some(file => file.architectures), item.id + ' requires its native CPU inventory');
    assert.ok(item.notices.every(notice => item.files.some(file => file.path === notice.path)));
  }
  for (const change of [{ size: -1 }, { mode: 0o666 }]) {
    const invalid = structuredClone(declarations[0]); Object.assign(invalid.files[0], change);
    assert.throws(() => S.validateDeclaration(invalid), /Invalid sealed supplemental native file/);
  }
  for (const change of [{ size: 0 }, { mode: 0o640 }]) {
    const valid = structuredClone(declarations[0]); Object.assign(valid.files[0], change);
    assert.equal(S.validateDeclaration(valid), valid, "Sealed inventories retain zero-length files and restricted read modes");
  }
  const portable = structuredClone(declarations[0]);
  const image = portable.files.find(file => file.architectures); image.format = "pe"; image.architectures = ["x86"];
  delete image.optionalLoad; delete image.executionArchitecture;
  assert.equal(S.validateDeclaration(portable), portable, "PE metadata describes the Windows image independently of the launcher CPU");
  image.architectures = ["unknown"];
  assert.throws(() => S.validateDeclaration(portable), /Invalid supplemental native architectures/);
});
test('release verification refuses a backend missing from the resilient runtime registry', () => {
  const lookup = Modules.getModule, missing = Modules.listModules()[0].id;
  Modules.getModule = id => id === missing ? null : lookup(id);
  try {
    assert.throws(() => S.verifyModuleDeclarations(), /Backend module failed to load for release verification/);
    assert.ok(S.declarations().length, 'Declarations are read as data without loading backend modules');
  }
  finally { Modules.getModule = lookup; }
});
test('declared custom helpers are included while managed helpers and other versions stay excluded', () => {
  const declarations = S.declarations(), helper = declarations.find(item => item.id === 'steam-api-helper');
  assert.ok(helper, 'The internal Steam API helper remains an approved included package');
  for (const id of ['python', 'sevenzip', 'evbunpack']) assert.equal(declarations.some(item => item.id === id), false, 'Stock ' + id + ' keeps its supplier/source route');
  for (const id of ['rpgmaker-decrypter','gamemaker-opengl-helper','innoextract']) assert.equal(declarations.some(item => item.id === id), false, id + ' uses managed delivery');
  const distribution = require('../scripts/distribution-model.cjs');
  const plan = distribution.createPlan({ arch: 'arm64', maximumMacOS: '13.0' });
  const resources = distribution.resourceRules(plan).find(rule => rule.from === 'src/resources');
  assert.deepEqual(plan.supplementals.filter(item => item.id === helper.id), [helper]);
  assert.equal(resources.filter.includes('native-runtimes/**'), false, 'Staged resources do not enter through a broad wildcard');
  const root = path.resolve(__dirname, '../src/resources'), { FileMatcher } = require('app-builder-lib/out/fileMatcher');
  const filter = new FileMatcher(root, '/app', value => value, resources.filter).createFilter();
  const selected = relative => filter(path.join(root, relative), { isDirectory: () => false });
  const nativeFile = helper.files.find(file => file.architectures).path;
  assert.equal(selected('native-runtimes/' + helper.directoryRelative + '/' + nativeFile), true);
  const stagedVersions = fs.readdirSync(path.join(root, 'native-runtimes', helper.id), { withFileTypes: true })
    .filter(item => item.isDirectory() && item.name !== helper.version).map(item => item.name);
  for (const version of [...stagedVersions, 'unselected-version'])
    assert.equal(selected('native-runtimes/' + helper.id + '/' + version + '/' + helper.arch + '/' + nativeFile), false, version);
  for (const id of ['rpgmaker-decrypter','gamemaker-opengl-helper','innoextract'])
    assert.equal(selected('native-runtimes/' + id + '/retained-version/universal/files/bin/helper'), false, 'Retained managed payload selected: ' + id);
  assert.equal(selected('python/bin/python3'), true);
  assert.equal(selected('7zip/7zz'), true);
});

test('native host dependencies use the shared checksum contract and preserve declared loader identities', () => {
  const row = { id: 'fixture-bridge', version: '1.0', sha256: 'a'.repeat(64), file: 'bridge.dylib',
    dependency: '@loader_path/libsteam_api.dylib', provider: { id: 'steam-api-helper', version: '0.5.0', file: 'libsteam_api.dylib' },
    installNames: ['@loader_path/bridge.dylib'] };
  assert.deepEqual(S.nativeHostDependencies({ nativeHostDependencies: () => [row] }), [row]);
  const registered = S.nativeHostDependencies(); assert.ok(registered.length);
  assert.ok(registered.every(item => typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)));
  for (const change of [{ sha256: 'invalid' }, { sha256: ['a'.repeat(64)] }, { file: '../outside' }, { dependency: '/outside/libsteam_api.dylib' }])
    assert.throws(() => S.nativeHostDependencies({ nativeHostDependencies: () => [{ ...row, ...change }] }), /Invalid native host|Unsafe bundled/);
});
