const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { image } = require('./fixtures/macho-image');

test('ART packages omit external images and Cargo products, materialize in-tree aliases and reject escaped aliases', async t => {
  const { packageArtAdapter } = await import('../src/modules/android/art/package.mjs');
  const { imageContentIdentity } = await import('../src/modules/android/art/build.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'android-art-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const supplierRoot = path.join(root, 'supplier'), commonRoot = path.join(root, 'common');
  const write = (relative, bytes, mode = 0o644) => {
    const file = path.join(root, relative);fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { mode });return file;
  };
  const archiveSha256 = crypto.createHash('sha256').update('Original fixture system-image archive').digest('hex');
  const originalCatalog = { sha256: 'a'.repeat(64), size: 1, mode: 0o644 };
  const supplierNotice = {name:'Android graphics',license:'Apache-2.0',path:'licenses/hwui/NOTICE'};
  write('supplier/runtime.json', JSON.stringify({ schemaVersion: 1, execution: 'art', android: { imageSha256: archiveSha256 },
    components: { image: 'image', halRoot: 'hal', linuxRun: 'host/linux-run', hwuiLibrary:'guest/libhwui.so', hwuiNotices:'licenses/hwui' },
    notices:[supplierNotice],
    platformSupplier: { schemaVersion: 1, image: { sha256: 'f'.repeat(64), records: 1, bytes: 1 }, catalog: originalCatalog },
    imageAcquisition: { delivery: 'explicit-download' } }));
  write('supplier/guest/libhwui.so', 'Complete adapted Android graphics module');
  write('supplier/licenses/hwui/NOTICE', 'Original Android graphics notice');
  write('outside-image/system/app/GoogleServices.apk', 'User-acquired system image must never enter the adapter.');
  fs.symlinkSync(path.join(root, 'outside-image'), path.join(supplierRoot, 'image'), 'dir');
  write('supplier/host/linux-run', image({ fileType: 2, installName: null,
    dependencies: ['@rpath/SDL3.framework/Versions/A/SDL3'], runPaths: ['@loader_path/../../native'] }), 0o755);
  fs.symlinkSync('linux-run', path.join(supplierRoot, 'host/linux-translate'));
  const halNames = ['allocator-service', 'audio-service', 'composer-service', 'libaim_allocator.so', 'libgles.so', 'libmapper.so'];
  for (const name of halNames.filter(name => name !== 'libgles.so')) write('supplier/hal/' + name, 'Original guest HAL: ' + name, name.endsWith('.so') ? 0o644 : 0o755);
  const gles = write('supplier/hal/build/libgles.so', 'Original in-tree guest GLES library');
  fs.symlinkSync('build/libgles.so', path.join(supplierRoot, 'hal/libgles.so'));
  for (const relative of ['Cargo.lock', '.cargo-lock', 'deps/compiler.rlib', 'build/compiler-output.o', 'incremental/session/cache.bin'])
    write('supplier/hal/' + relative, 'Compiler-only artifact: ' + relative);
  const sdl = write('common/native/SDL3.framework/Versions/A/SDL3', image({
    installName: '@rpath/SDL3.framework/Versions/A/SDL3' }), 0o755);
  write('common/native/SDL3.framework/Versions/A/Resources/Info.plist', '<plist/>');
  fs.symlinkSync('A', path.join(commonRoot, 'native/SDL3.framework/Versions/Current'), 'dir');
  fs.symlinkSync('Versions/Current/SDL3', path.join(commonRoot, 'native/SDL3.framework/SDL3'));
  fs.symlinkSync('Versions/Current/Resources', path.join(commonRoot, 'native/SDL3.framework/Resources'), 'dir');
  write('common/notices/LICENSE.txt', 'Original fixture license notice');
  write('common/runtime.json', JSON.stringify({ profile: { javaMajor: 21 }, notices: [{
    name: 'Fixture source', license: 'MIT', path: 'notices/LICENSE.txt', sourceUrl: 'https://example.com/source'
  }] }));
  const extractor = write('extractor/android-image-extract', image({ fileType: 2, installName: null }), 0o755);
  const sourceArchive = write('source/source.tar.gz', 'Corresponding fixture source archive');
  const originalImage = { archiveSha256, content: imageContentIdentity(path.join(root, 'outside-image')) };
  const options = { supplierRoot, commonRoot, extractor, sourceArchive, originalImage };
  const invalidOutput = path.join(root, 'invalid-parent/adapter');
  for (const invalid of [undefined, null, {}, { ...originalImage, archiveSha256: '0'.repeat(64) },
    { ...originalImage, content: { ...originalImage.content, sha256: 'invalid' } },
    { ...originalImage, content: { ...originalImage.content, records: 0 } },
    { ...originalImage, content: { ...originalImage.content, bytes: 0 } }]) {
    assert.throws(() => packageArtAdapter({ ...options, originalImage: invalid, output: invalidOutput }), /verified original system image identity/);
    assert.equal(fs.existsSync(path.dirname(invalidOutput)), false, 'Invalid original identity must fail before creating a stage');
  }
  const output = path.join(root, 'adapter'), result = packageArtAdapter({ ...options, output });
  const files = result.declaration.files.map(file => file.path);
  assert.deepEqual(files.filter(file => file.startsWith('art/hal/')).sort(), halNames.map(name => 'art/hal/' + name).sort());
  assert.ok(!files.some(file => /(?:^|\/)(?:image|deps|build|incremental)(?:\/|$)|Cargo\.lock|\.cargo-lock/.test(file)));
  assert.equal(fs.existsSync(path.join(output, 'art/image')), false);
  for (const [relative, original] of [
    ['art/host/linux-translate', path.join(supplierRoot, 'host/linux-run')],
    ['art/hal/libgles.so', gles],
    ['native/SDL3.framework/SDL3', sdl],
    ['native/SDL3.framework/Versions/Current/SDL3', sdl]
  ]) {
    assert.equal(fs.lstatSync(path.join(output, relative)).isFile(), true, relative);
    assert.deepEqual(fs.readFileSync(path.join(output, relative)), fs.readFileSync(original), relative);
  }
  assert.equal(fs.lstatSync(path.join(output, 'native/SDL3.framework/Resources')).isDirectory(), true);
  assert.equal(require('../src/modules/shared/runtime/bundled-native').verifyPayload(output, result.declaration), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'runtime.json')));
  assert.match(manifest.minimumMacOS, /^13\.0(?:\.0)?$/);
  assert.deepEqual(manifest.dependencies.find(item => item.file === 'art/host/linux-run').links,
    ['@rpath/SDL3.framework/Versions/A/SDL3']);
  const runtime = JSON.parse(fs.readFileSync(path.join(output, 'art/runtime.json')));
  assert.equal(runtime.components.image, 'image');
  assert.equal(runtime.components.imageExtractor, 'host/android-image-extract');
  assert.equal(runtime.imageAcquisition.delivery, 'explicit-download');
  assert.equal(runtime.components.hwuiLibrary,'guest/libhwui.so');
  assert.deepEqual(fs.readFileSync(path.join(output,'art/guest/libhwui.so')),fs.readFileSync(path.join(supplierRoot,'guest/libhwui.so')));
  const packagedSupplierNotice={...supplierNotice,path:'art/'+supplierNotice.path};
  assert.deepEqual(result.declaration.notices.at(-1),packagedSupplierNotice);
  assert.deepEqual(runtime.platformSupplier.image, originalImage.content, 'Published image identity must come from the verified original, not the development copy');
  assert.deepEqual(runtime.platformSupplier.catalog, originalCatalog, 'Replacing the image identity must retain the separate package catalog');
  assert.deepEqual(fs.readFileSync(path.join(output, 'source.tar.gz')), fs.readFileSync(sourceArchive));

  const originalCommon = fs.readFileSync(path.join(commonRoot, 'runtime.json'));
  const noticeRecords = JSON.parse(originalCommon).notices;
  fs.writeFileSync(path.join(commonRoot, 'runtime.json'), JSON.stringify({profile:{javaMajor:21}}));
  fs.copyFileSync(sourceArchive, path.join(commonRoot, 'source.tar.gz'));
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const inventory = ['runtime.json', 'source.tar.gz', 'notices/LICENSE.txt', 'native/SDL3.framework/Versions/A/SDL3'].map(relative => {
    const file = path.join(commonRoot, relative), stat = fs.statSync(file);
    return {path:relative,size:stat.size,mode:stat.mode & 0o777,sha256:hash(file),
      ...(relative.endsWith('/SDL3') ? {architectures:['arm64']} : {})};
  });
  const commonDeclaration = {...result.declaration,id:'android',version:'fixture-common',
    directoryRelative:'android/fixture-common/arm64',manifestSha256:hash(path.join(commonRoot,'runtime.json')),
    sourceSha256:hash(path.join(commonRoot,'source.tar.gz')),files:inventory,notices:noticeRecords};
  const explicitOutput = path.join(root, 'explicit-notices');
  assert.throws(() => packageArtAdapter({...options,output:explicitOutput}), /matching common runtime declaration/,
    'An unrelated selected runtime cannot supply notice ownership');
  const explicit = packageArtAdapter({...options,commonDeclaration,output:explicitOutput});
  assert.deepEqual(explicit.declaration.notices, [...noticeRecords,packagedSupplierNotice], 'Common and ART notices retain their exact producer ownership');
  const mismatch = {...commonDeclaration,manifestSha256:'a'.repeat(64),
    files:inventory.map(row => row.path === 'runtime.json' ? {...row,sha256:'a'.repeat(64)} : row)};
  assert.throws(() => packageArtAdapter({...options,commonDeclaration:mismatch,output:path.join(root,'wrong-notices')}), /notice metadata differs/);
  fs.writeFileSync(path.join(commonRoot,'runtime.json'), originalCommon);

  const originalSupplier=fs.readFileSync(path.join(supplierRoot,'runtime.json'));
  const invalidSupplier=JSON.parse(originalSupplier);invalidSupplier.notices=[{...supplierNotice,path:'../notices/LICENSE.txt'}];
  fs.writeFileSync(path.join(supplierRoot,'runtime.json'),JSON.stringify(invalidSupplier));
  assert.throws(()=>packageArtAdapter({...options,output:path.join(root,'escaped-notice')}),/license notice is missing/);
  assert.deepEqual(fs.readdirSync(root).filter(name=>name.startsWith('.android-art-')),[]);
  fs.writeFileSync(path.join(supplierRoot,'runtime.json'),originalSupplier);

  const secret = write('outside/private-data', 'Outside the immutable supplier');
  fs.symlinkSync(secret, path.join(supplierRoot, 'host/escaped-alias'));
  const rejected = path.join(root, 'rejected');
  assert.throws(() => packageArtAdapter({ ...options, output: rejected }), /escapes its source/);
  assert.equal(fs.existsSync(rejected), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.android-art-')), [], 'Failed packaging must remove its stage');
  fs.unlinkSync(path.join(supplierRoot, 'host/escaped-alias'));

  for (const [output, absentParent] of [
    [path.join(supplierRoot, 'new-output/adapter'), path.join(supplierRoot, 'new-output')],
    [path.join(commonRoot, 'notices/new-output/adapter'), path.join(commonRoot, 'notices/new-output')]
  ]) {
    assert.throws(() => packageArtAdapter({ ...options, output }), /overlap/);
    assert.equal(fs.existsSync(absentParent), false, 'Rejected overlap must not create producer directories');
  }
  const linkedParent = path.join(root, 'linked-parent');
  fs.symlinkSync(path.join(supplierRoot, 'host'), linkedParent, 'dir');
  assert.throws(() => packageArtAdapter({ ...options, output: path.join(linkedParent, 'future/adapter') }), /overlap/);
  assert.equal(fs.existsSync(path.join(supplierRoot, 'host/future')), false, 'Future paths must resolve existing aliases before overlap checks');

  fs.symlinkSync('..', path.join(supplierRoot, 'host/ancestor'), 'dir');
  assert.throws(() => packageArtAdapter({ ...options, output: rejected }), /recursive|cycle/i);
  assert.equal(fs.existsSync(rejected), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.android-art-')), [], 'Recursive alias rejection must remove its stage');
  fs.unlinkSync(path.join(supplierRoot, 'host/ancestor'));
  write('supplier/host/linux-run', image({ fileType: 2, installName: null,
    dependencies: ['@rpath/missing.dylib'], runPaths: ['@loader_path/../../native'] }), 0o755);
  assert.throws(() => packageArtAdapter({ ...options, output: rejected }), /native dependency is missing: @rpath\/missing\.dylib/);
  assert.equal(fs.existsSync(rejected), false);
  assert.deepEqual(fs.readdirSync(root).filter(name => name.startsWith('.android-art-')), [], 'Missing closure rejection must remove its stage');
});
