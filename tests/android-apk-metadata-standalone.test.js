const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const helper = process.env.ANDROID_APK_METADATA_HELPER || (() => {
  try { return require('../src/modules/android/tools/apk-metadata').resolve().executable; }
  catch { return null; }
})();
const enabled = process.platform === 'darwin' && helper && fs.existsSync(helper);
const fixture = path.join(__dirname, 'fixtures/android-package-metadata/metadata.apk');
const splits = path.join(__dirname, 'fixtures/android-apk-metadata-standalone');

test('standalone APK metadata resolves localized adaptive icons and split resources without Java', { skip: !enabled }, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maclauncher-apk-metadata-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let sequence = 0;
  function run(sourceApks, locale = 'en-US', extra = {}) {
    const outputDirectory = path.join(root, String(sequence++));
    fs.mkdirSync(outputDirectory, { mode: 0o700 });
    const child = spawnSync(path.resolve(helper), [], {
      env: { PATH: '/usr/bin:/bin' }, timeout: 5000, maxBuffer: 1024 * 1024,
      input: JSON.stringify({ sourceApks, locale, outputDirectory, ...extra }), encoding: 'utf8',
    });
    assert.ifError(child.error);
    return { child, outputDirectory, value: child.status === 0 ? JSON.parse(child.stdout) : null };
  }
  function png(result) {
    assert.equal(result.value.iconFile, path.join(result.outputDirectory, 'icon.png'));
    const bytes = fs.readFileSync(result.value.iconFile);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), 256);
    assert.equal(bytes.readUInt32BE(20), 256);
    assert.equal(fs.statSync(result.value.iconFile).mode & 0o777, 0o600);
  }
  const english = run([fixture]);
  assert.equal(english.child.status, 0, english.child.stderr);
  assert.equal(english.value.label, 'Metadata Game');
  assert.equal(english.value.packageName, 'org.maclauncher.metadata.fixture');
  png(english);
  const french = run([fixture], 'fr-FR');
  assert.equal(french.value.label, 'Jeu Métadonnées');
  png(french);
  const base = path.join(splits, 'base.apk'), resources = path.join(splits, 'resources.apk');
  const unavailable = run([base]);
  assert.equal(unavailable.child.status, 0, unavailable.child.stderr);
  assert.equal(unavailable.value.label, 'org.maclauncher.metadata.fixture');
  assert.equal(unavailable.value.iconFile, null);
  const combined = run([base, resources], 'fr-FR');
  assert.equal(combined.child.status, 0, combined.child.stderr);
  assert.equal(combined.value.label, 'Jeu Métadonnées');
  png(combined);
  assert.deepEqual(combined.value.activityWindows['org.maclauncher.metadata.fixture.Landscape'], { landscape: true });
  assert.deepEqual(combined.value.activityWindows['org.maclauncher.metadata.fixture.Portrait'], { landscape: false });
  assert.deepEqual(combined.value.activityWindows['org.maclauncher.metadata.fixture.LandscapeAlias'], { landscape: true });
  for (const [sources, message] of [
    [[resources, base], /base APK must be the first source/],
    [[base, path.join(splits, 'foreign.apk')], /different package/],
    [[base, base], /not a split/],
  ]) {
    const result = run(sources);
    assert.equal(result.child.status, 1);
    assert.match(result.child.stderr, message);
    assert.equal(result.child.stdout, '');
    assert.deepEqual(fs.readdirSync(result.outputDirectory), []);
  }
  const bad = run([fixture], 'en-US', { sourceApks: [] });
  assert.equal(bad.child.status, 1);
  assert.match(bad.child.stderr, /1 to 1024/);
});

test('adaptive icon viewport fills its intended bounds while legacy vectors keep their scale', { skip: !enabled }, t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'android-icon-viewport-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const files=[];
  for(const [name,source]of [['adaptive',fixture],['legacy',path.join(splits,'legacy-vector.apk')]]){
    const outputDirectory=path.join(root,name);fs.mkdirSync(outputDirectory);
    const child=spawnSync(path.resolve(helper),[],{input:JSON.stringify({sourceApks:[source],locale:'en-US',outputDirectory}),encoding:'utf8',timeout:5000});
    assert.equal(child.status,0,child.stderr);files.push(JSON.parse(child.stdout).iconFile);
  }
  const script='ObjC.import("AppKit");function run(argv){return JSON.stringify(argv.map(file=>{const p=$.NSBitmapImageRep.imageRepWithContentsOfFile(file);return [[80,128],[100,128],[65,128],[0,0]].map(q=>{const c=p.colorAtXY(q[0],q[1]);return [c.redComponent,c.greenComponent,c.blueComponent,c.alphaComponent];});}));}';
  const sample=JSON.parse(spawnSync('/usr/bin/osascript',['-l','JavaScript','-e',script,...files],{encoding:'utf8',timeout:10000}).stdout);
  assert.ok(sample[0][0].slice(0,3).every(v=>v>.99),'The 72 dp adaptive viewport exposes the foreground at pixel80');
  assert.ok(sample[0][2][2]>.7&&sample[0][2][0]<.3,'Adaptive background remains visible outside the original foreground');
  assert.equal(sample[0][3][3],1,'Raw artwork retains full bounds before the shared Dock silhouette');
  assert.equal(sample[1][0][3],0,'Legacy drawable geometry is not enlarged by adaptive overscan');
  assert.ok(sample[1][1].every(v=>v>.99),'Legacy foreground remains at its original scale');
});
