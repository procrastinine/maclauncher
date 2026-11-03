const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const pins = require('../fixtures/android-tools.json');
const ROOT = path.resolve(__dirname, '../..');
const Published = require('../../scripts/published-inputs.cjs');
const Zip = require('../../src/modules/shared/runtime/zip');
const { writeZipArchive } = require('./zip-fixture');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function paths(root = ROOT) {
  const directory = path.join(root, 'dist/android-fixture-tools', process.platform);
  return { directory, aapt2: path.join(directory, 'aapt2'), android: path.join(directory, 'android.jar'), r8: path.join(directory, 'r8.jar') };
}
async function prepareTools({ root = ROOT, fetch = Boolean(process.env.CI), download = require('../../scripts/native-payload.cjs').downloadPayload } = {}) {
  const selected = pins[process.platform];
  if (!selected) return { ready: false, reason: 'Android fixture tools are available on macOS and Linux.' };
  const output = paths(root), cache = path.join(root, 'dist/upstream-downloads');
  fs.mkdirSync(cache, { recursive: true });
  const inputs = [[selected, 'aapt2', 'aapt2'], [pins.sdkPlatform, 'android-36/android.jar', 'android'], [pins.r8, null, 'r8']];
  for (const [pin, entry, key] of inputs) {
    const archive = path.join(cache, pin.sha256 + '.bin');
    if (!fs.existsSync(archive)) {
      if (!fetch) return { ready: false, reason: 'Pinned Android fixture tools are absent offline; CI fetches them, or run node tests/helpers/android-fixture-tools.cjs --fetch.' };
      await download(pin.url, archive);
    }
    Published.assertArchive(archive, pin);
    fs.mkdirSync(output.directory, { recursive: true });
    const bytes = entry ? Zip.readZipEntryBuffer(archive, entry) : fs.readFileSync(archive);
    if (!bytes) throw new Error('Publisher fixture archive omits ' + entry);
    const temporary = output[key] + '.' + crypto.randomUUID();
    try { fs.writeFileSync(temporary, bytes, {flag:'wx', mode:key==='aapt2'?0o755:0o644}); fs.renameSync(temporary, output[key]); }
    finally { fs.rmSync(temporary, {force:true}); }
  }
  return { ready: true };
}
const generated = new WeakMap();
function metadataAvailable(t) {
  const tools = paths();
  if (![tools.aapt2, tools.android].every(file=>fs.existsSync(file))) {
    const reason = 'Pinned aapt2/Android API fixture tools are absent offline; CI fetches them before tests.';
    if (process.env.CI) throw new Error(reason);
    t?.skip(reason); return false;
  }
  if (!t || typeof t.after !== 'function') throw new Error('Resource fixtures require a test context.');
  if (!generated.has(t)) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'android-metadata-fixture-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    generateMetadata(tools,directory);generated.set(t,directory);
  }
  return true;
}
function metadataApk(t,name='metadata'){
 if(!['metadata','base','resources','legacy-vector'].includes(name))throw new Error('Unknown resource fixture.');
 if(!metadataAvailable(t))throw new Error('Pinned Android fixture tools are absent offline.');
 return path.join(generated.get(t),name+'.apk');
}
function generateMetadata(tools,temporary) {
  const fixtures = path.join(ROOT, 'tests/fixtures'), source = path.join(fixtures, 'android-package-metadata');
  const run = args => execFileSync(tools.aapt2, args, {stdio:'pipe', timeout:30000});
  {
    const resources = path.join(temporary, 'res.zip');
    run(['compile','--dir',path.join(source,'res'),'-o',resources]);
    const output = path.join(temporary,'metadata.apk');
    run(['link','-I',tools.android,'--manifest',path.join(source,'AndroidManifest.xml'),'-o',output,resources]);
    const splitRoot = path.join(fixtures,'android-apk-metadata-standalone');
    const base = path.join(temporary,'base.apk');
    writeZipArchive(base,[{name:'AndroidManifest.xml',data:Zip.readZipEntryBuffer(output,'AndroidManifest.xml')}]);
    const split = path.join(temporary,'resources.apk');
    run(['link','-I',tools.android,'--manifest',path.join(splitRoot,'resources.xml'),'-o',split,resources]);
    const legacyResources=path.join(temporary,'legacy-res');fs.cpSync(path.join(source,'res'),legacyResources,{recursive:true});
    fs.copyFileSync(path.join(source,'res/drawable/foreground.xml'),path.join(legacyResources,'mipmap-anydpi-v26/ic_launcher.xml'));
    const compiled=path.join(temporary,'legacy-res.zip'),legacy=path.join(temporary,'legacy-vector.apk');
    run(['compile','--dir',legacyResources,'-o',compiled]);
    run(['link','-I',tools.android,'--manifest',path.join(source,'AndroidManifest.xml'),'-o',legacy,compiled]);
  }
}
module.exports={prepareTools,metadataAvailable,metadataApk,paths};
if(require.main===module) prepareTools({fetch:process.argv.includes('--fetch')||Boolean(process.env.CI)}).then(result=>{
  console.log(JSON.stringify(result));
}).catch(error=>{console.error(error.message);process.exitCode=1;});
