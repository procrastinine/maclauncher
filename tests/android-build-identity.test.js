const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
// The launcher source audit consumes this producer's source-closure identity.
test('Android compilation uses one complete fixed source tree and identity detects added sources',async t=>{
  const {sourceInventory,sourceIdentity,snapshotSources}=await import('../src/external/maclauncher-android/src/modules/android/native/build-sources.mjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'android-build-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const native=path.join(root,'module/native'),snapshot=path.join(root,'snapshot');
  fs.mkdirSync(path.join(native,'nested'),{recursive:true});fs.writeFileSync(path.join(native,'native.c'),'original native');
  fs.writeFileSync(path.join(native,'nested/new.java'),'original Java');fs.writeFileSync(path.join(root,'module/profile.js'),'original profile');
  const captured=snapshotSources(native,snapshot);
  fs.writeFileSync(path.join(native,'native.c'),'changed native');
  fs.writeFileSync(path.join(root,'module/profile.js'),'changed profile');
  assert.equal(fs.readFileSync(path.join(snapshot,'native/native.c'),'utf8'),'original native');
  assert.equal(fs.readFileSync(path.join(snapshot,'profile.js'),'utf8'),'original profile');
  assert.deepEqual(sourceIdentity(sourceInventory(path.join(snapshot,'native')),fs.readFileSync(path.join(snapshot,'profile.js'))),captured);
  fs.writeFileSync(path.join(native,'native.c'),'original native');fs.writeFileSync(path.join(root,'module/profile.js'),'original profile');
  const current=()=>sourceIdentity(sourceInventory(native),fs.readFileSync(path.join(root,'module/profile.js')));
  assert.equal(current().sourceHash,captured.sourceHash);
  fs.writeFileSync(path.join(native,'new-module.java'),'automatically included');assert.notEqual(current().sourceHash,captured.sourceHash);
  fs.unlinkSync(path.join(native,'new-module.java'));fs.unlinkSync(path.join(native,'nested/new.java'));assert.notEqual(current().sourceHash,captured.sourceHash);
});

test('Normal Android builder snapshots helpers without evaluating the platform graph',async t=>{
  const {execFileSync}=require('node:child_process');
  const {sourceInventory,sourceIdentity}=await import('../src/external/maclauncher-android/src/modules/android/native/build-sources.mjs');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-build-inputs-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const root=path.join(temporary,'src/modules/android/native'),work=path.join(temporary,'work');
  const write=(name,bytes)=>{const file=path.join(temporary,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;};
  const original=path.join(__dirname,'../src/external/maclauncher-android/src/modules/android/native');
  for(const name of ['build.mjs','build-sources.mjs','upstream/source-files.mjs'])
    write('src/modules/android/native/'+name,fs.readFileSync(path.join(original,name)));
  write('src/modules/android/profile.js','module.exports={};\n');
  write('src/modules/android/apk.js','module.exports={originalApkHelper:true};\n');
  write('src/modules/android/binary-manifest.js','module.exports={originalManifestHelper:true};\n');
  write('src/modules/android/art/source.mjs','export const adapter="original ART adapter";\n');
  write('src/modules/android/art/native/original.rs','original ART native boundary\n');
  write('src/modules/android/art/launch.mjs','launcher-only orchestration\n');
  write('src/modules/shared/runtime/helper.js','module.exports={};\n');
  write('src/modules/shared/runtime/nested/new-helper.js','module.exports={};\n');
  write('src/modules/nitroplus/runtime/portable-media.json','{}\n');
  write('src/modules/android/native/build-options.mjs','export function completeBuildOptions() {}\n');
  write('src/modules/android/native/build-workspace.mjs',
    'import fs from "node:fs"; export function enterBuildWorkspace({directory,output}) { fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(output,{recursive:true});return true; }');
  write('src/modules/android/native/compile.mjs',
    'import fs from "node:fs";import path from "node:path";const args=process.argv.slice(2),options={};for(let i=0;i<args.length;i+=2)options[args[i].slice(2)]=args[i+1];fs.writeFileSync(path.join(options.output,"observed.json"),JSON.stringify(options));');
  const captures=[];
  for(const name of ['first','second']){
    const parser=write(name+'/parser','original parser'),sources=write(name+'/parser-sources.json',JSON.stringify({localSource:path.join(temporary,name,'original')}));
    const output=path.join(temporary,name+'/runtime');
    execFileSync(process.execPath,[path.join(root,'build.mjs'),'--output',output,'--build-work',work,'--blueprint-parser',parser,'--blueprint-parser-sources',sources]);
    const source=path.join(output,'source'),identity=JSON.parse(fs.readFileSync(path.join(output,'build-source.json')));
    const observed=JSON.parse(fs.readFileSync(path.join(output,'observed.json')));
    assert.equal(observed['blueprint-parser'],parser);
    assert.equal(observed['blueprint-parser-sources'],sources);
    assert.equal(observed['component-composition'],undefined);
    assert.equal(fs.existsSync(path.join(work,'component-composition.json')),false);
    assert.deepEqual(sourceIdentity(sourceInventory(path.join(source,'native')),fs.readFileSync(path.join(source,'profile.js')),
      sourceInventory(path.join(source,'build-tools')),sourceInventory(path.join(source,'art'))),identity);
    assert.deepEqual(identity.artSources.map(row=>row.path),['native/original.rs','source.mjs']);
    assert.equal(fs.existsSync(path.join(source,'art/launch.mjs')),false);
    assert.deepEqual(identity.buildToolsSources.map(row=>row.path),[
      'src/modules/android/apk.js','src/modules/android/binary-manifest.js',
      'src/modules/shared/runtime/helper.js','src/modules/shared/runtime/nested/new-helper.js']);
    assert.equal(fs.existsSync(path.join(source,'build-tools/src/modules/nitroplus/runtime/portable-media.json')),false,
      'Unconsumed module fixtures are excluded from the producer source closure');
    assert.equal(JSON.stringify(identity).includes(temporary),false);
    captures.push(identity);
  }
  assert.equal(captures[0].sourceHash,captures[1].sourceHash,'Local parser/output paths do not change corresponding source identity');
});

test('ART producer sources are fixed beside the JVM source snapshot',async t=>{
  const {snapshotSources,sourceInventory,sourceIdentity}=await import('../src/external/maclauncher-android/src/modules/android/native/build-sources.mjs');
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'android-art-build-source-'));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
  const native=path.join(temporary,'module/native'),art=path.join(temporary,'module/art'),snapshot=path.join(temporary,'snapshot');
  fs.mkdirSync(native,{recursive:true});fs.mkdirSync(art);
  fs.writeFileSync(path.join(native,'native.c'),'native');fs.writeFileSync(path.join(temporary,'module/profile.js'),'profile');
  fs.writeFileSync(path.join(art,'build.mjs'),'original ART producer');
  const captured=snapshotSources(native,snapshot);
  fs.writeFileSync(path.join(art,'build.mjs'),'changed ART producer');
  assert.equal(fs.readFileSync(path.join(snapshot,'art/build.mjs'),'utf8'),'original ART producer');
  const identity=()=>sourceIdentity(sourceInventory(native),Buffer.from('profile'),[],sourceInventory(art));
  assert.notEqual(identity().sourceHash,captured.sourceHash);
  fs.writeFileSync(path.join(art,'build.mjs'),'original ART producer');assert.equal(identity().sourceHash,captured.sourceHash);
  fs.writeFileSync(path.join(art,'new-boundary.rs'),'automatically captured');assert.notEqual(identity().sourceHash,captured.sourceHash);
});
