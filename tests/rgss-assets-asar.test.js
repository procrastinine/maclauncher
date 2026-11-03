const { finished } = require("node:stream/promises");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

let electron;
try { electron = require("electron"); } catch {}
const available = typeof electron === "string" && fs.existsSync(electron);

async function fixture(t, unpacked, heldStats) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rgss-asar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), moduleRoot = path.join(source, "src", "modules", "rgss");
  for (const relative of ["assets.js", "rgss-utils.js", "overlays/kawariki/patches-extra.rb", "../shared/copy-file.js", "../shared/file-time.js"]) {
    const destination = path.join(moduleRoot, relative); fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "../src/modules/rgss", relative), destination);
  }
  const fontRelative = "src/modules/rgss/resources/soundfont/GMGSx.SF2";
  fs.mkdirSync(path.dirname(path.join(source, fontRelative)), { recursive: true }); fs.writeFileSync(path.join(source, fontRelative), "font");
  const archive = path.join(root, "app.asar");
  await finished(await require("@electron/asar").createPackageWithOptions(source, archive, unpacked ? { unpack: "*.SF2" } : {}));
  assert.equal(fs.existsSync(path.join(archive + ".unpacked", fontRelative)), unpacked);
  const kawarikiRoot = path.join(root, "kawariki"); fs.mkdirSync(kawarikiRoot);
  fs.writeFileSync(path.join(kawarikiRoot, "preload.rb"), "Kernel.require File.join(Preload::Path, 'patches.rb')\n");
  fs.writeFileSync(path.join(kawarikiRoot, "patches.rb"), "# original\n");
  const runner = path.join(root, "check.cjs");
  fs.writeFileSync(runner, `
const assert=require('node:assert/strict'),fs=require('node:fs'),raw=require('original-fs'),path=require('node:path');
const options=JSON.parse(process.argv[2]),archive=raw.realpathSync(options.archive),font=archive+'/'+options.fontRelative;
const Assets=require(archive+'/src/modules/rgss/assets.js'),input={userDataDir:options.userDataDir,kawarikiRoot:options.kawarikiRoot,resourceRoot:archive+'/src/modules/rgss/resources'};
const {hasFineChangeTime}=require(archive+'/src/modules/shared/file-time.js');
const rawMetadata=()=>{const s=raw.lstatSync(archive,{bigint:true});return [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String);};
const before=rawMetadata(),virtualBefore=String(fs.lstatSync(font,{bigint:true}).ino),virtualAfter=String(fs.lstatSync(font,{bigint:true}).ino);
assert.notEqual(virtualBefore,virtualAfter,'Exercise actual Electron synthetic inode behavior');
const first=Assets.ensureAssetsStaged(input);assert.equal(first.assetsStaged,true);
const open=fs.openSync,read=fs.readSync,close=fs.closeSync,descriptors=new Set();let sourceReads=0;
fs.openSync=function(file,...args){const fd=open(file,...args);if(file===font)descriptors.add(fd);return fd;};
fs.readSync=function(fd,...args){if(descriptors.has(fd))sourceReads++;return read(fd,...args);};
fs.closeSync=function(fd){descriptors.delete(fd);return close(fd);};
for(let i=0;i<3;i++){const warm=Assets.ensureAssetsStaged(input);assert.equal(warm.generationRoot,first.generationRoot);assert.equal(warm.stagedNow,false);}
const fine=hasFineChangeTime(raw.lstatSync(archive,{bigint:true}))&&(!options.unpacked||hasFineChangeTime(raw.lstatSync(archive+'.unpacked/'+options.fontRelative,{bigint:true})));
if(fine)assert.equal(sourceReads,0,'Unchanged fine-stamped packaged files must reuse content hashes');
else assert.ok(sourceReads>0,'Ambiguous packaged files must recheck their bytes');
const warmSourceReads=sourceReads;
assert.equal(Assets.ensureAssetsStaged({...input,force:true}).generationRoot,first.generationRoot);
assert.ok(sourceReads>0,'Force refresh must exercise the actual virtual file read');
assert.deepEqual(rawMetadata(),before);
fs.openSync=open;fs.readSync=read;fs.closeSync=close;
if(!options.unpacked){
const sidecar=archive+'.unpacked/'+options.fontRelative;raw.mkdirSync(path.dirname(sidecar),{recursive:true});raw.writeFileSync(sidecar,'junk');
assert.equal(Assets.ensureAssetsStaged({...input,force:true}).generationRoot,first.generationRoot);
assert.equal(fs.readFileSync(path.join(first.generationRoot,'soundfont','GMGSx.SF2'),'utf8'),'font');
}
if(options.heldStats){
const physical=archive+'.unpacked/'+options.fontRelative,heldPath=options.unpacked?physical:archive;
const original={lstat:raw.lstatSync,rawFstat:raw.fstatSync,fstat:fs.fstatSync,rawOpen:raw.openSync,rawRead:raw.readSync,rawClose:raw.closeSync};
const actual=original.lstat(heldPath,{bigint:true});
const held=Object.assign(Object.create(Object.getPrototypeOf(actual)),actual,{mtimeNs:actual.mtimeNs/1000000000n*1000000000n,ctimeNs:actual.ctimeNs/1000000000n*1000000000n,
mtimeMs:actual.mtimeMs/1000n*1000n,ctimeMs:actual.ctimeMs/1000n*1000n});
assert.equal(hasFineChangeTime(held),false);
const snapshot=s=>[s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String);
const sourceFds=new Set(),backingFds=new Set();let positiveReads=0,mutated=false,failedReads=0;
const sentinel=Object.assign(new Error('RGSS held-stat verification read failed'),{code:'EIO'});
const sameFile=s=>s.dev===actual.dev&&s.ino===actual.ino;
raw.lstatSync=function(file,...args){const s=original.lstat(file,...args);return file===heldPath&&args[0]?.bigint?held:s;};
raw.fstatSync=function(fd,...args){const s=original.rawFstat(fd,...args);return args[0]?.bigint&&sameFile(s)?held:s;};
fs.fstatSync=function(fd,...args){const s=original.fstat(fd,...args);return args[0]?.bigint&&sameFile(s)?held:s;};
fs.openSync=function(file,...args){const fd=open(file,...args);if(file===font)sourceFds.add(fd);return fd;};
fs.closeSync=function(fd){sourceFds.delete(fd);return close(fd);};
raw.openSync=function(file,...args){const fd=original.rawOpen(file,...args);if(file===heldPath)backingFds.add(fd);return fd;};
raw.closeSync=function(fd){backingFds.delete(fd);return original.rawClose(fd);};
try{
assert.equal(Assets.ensureAssetsStaged(input).generationRoot,first.generationRoot);
fs.readSync=function(fd,...args){if(sourceFds.has(fd))positiveReads++;return read(fd,...args);};
assert.equal(Assets.ensureAssetsStaged(input).generationRoot,first.generationRoot);
assert.ok(positiveReads>0,'An already warm coarse identity must still read source bytes');
const marker=path.join(options.userDataDir,'modules/rgss/assets/.maclauncher-assets.json'),markerBefore=fs.readFileSync(marker),generations=path.dirname(first.generationRoot),namesBefore=fs.readdirSync(generations);
let payloadOffset;
if(!options.unpacked){const bytes=raw.readFileSync(archive),length=bytes.readUInt32LE(4);let member=JSON.parse(bytes.subarray(16,16+bytes.readUInt32LE(12)).toString());for(const segment of options.fontRelative.split('/'))member=member.files[segment];payloadOffset=8+length+Number(member.offset);}
fs.readSync=function(fd,...args){
if(sourceFds.has(fd)&&options.heldStats==='descriptor-error'&&typeof args[3]==='number'){failedReads++;throw sentinel;}
const n=read(fd,...args);if(sourceFds.has(fd)&&n>0&&!mutated&&options.heldStats==='rewrite'){
mutated=true;if(options.unpacked)raw.writeFileSync(physical,'FONT');else{const fd=original.rawOpen(archive,'r+');try{raw.writeSync(fd,Buffer.from('FONT'),0,4,payloadOffset);}finally{original.rawClose(fd);}}
}return n;};
raw.readSync=function(fd,...args){if(backingFds.has(fd)&&options.heldStats==='backing-error'){failedReads++;throw sentinel;}return original.rawRead(fd,...args);};
if(options.heldStats==='rewrite'){
assert.throws(()=>Assets.ensureAssetsStaged({...input,force:true}),{message:'RGSS asset source changed while reading.'});
assert.equal(mutated,true,'Actual source bytes must change inside the guarded read');
assert.deepEqual(snapshot(raw.lstatSync(heldPath,{bigint:true})),snapshot(held),'Every identity field stayed held during the mutation');
}else{assert.throws(()=>Assets.ensureAssetsStaged({...input,force:true}),error=>error===sentinel);assert.equal(failedReads,1,'The exact verification I/O failure must escape once');}
assert.deepEqual(fs.readFileSync(marker),markerBefore,'Failed source validation must not replace the accepted marker');
assert.deepEqual(fs.readdirSync(generations),namesBefore,'Failed validation must publish no generation or stage');
assert.equal(fs.readFileSync(path.join(first.generationRoot,'soundfont','GMGSx.SF2'),'utf8'),'font');
assert.equal(sourceFds.size,0,'All virtual source descriptors must close after failure');
assert.equal(backingFds.size,0,'All real backing descriptors must close after failure');
fs.readSync=read;raw.readSync=original.rawRead;
if(mutated&&options.unpacked){const updated=Assets.ensureAssetsStaged(input);assert.notEqual(updated.generationRoot,first.generationRoot);assert.equal(fs.readFileSync(path.join(updated.generationRoot,'soundfont','GMGSx.SF2'),'utf8'),'FONT');assert.equal(fs.readFileSync(path.join(first.generationRoot,'soundfont','GMGSx.SF2'),'utf8'),'font');}
if(mutated&&!options.unpacked){const fd=original.rawOpen(archive,'r+');try{raw.writeSync(fd,Buffer.from('font'),0,4,payloadOffset);}finally{original.rawClose(fd);}}
}finally{raw.lstatSync=original.lstat;raw.fstatSync=original.rawFstat;fs.fstatSync=original.fstat;fs.openSync=open;fs.readSync=read;fs.closeSync=close;raw.openSync=original.rawOpen;raw.readSync=original.rawRead;raw.closeSync=original.rawClose;}
}else{
let mutated=false,targetFd;
fs.openSync=function(file,...args){const fd=open(file,...args);if(file===font)targetFd=fd;return fd;};
fs.readSync=function(fd,...args){const n=read(fd,...args);if(fd===targetFd&&!mutated){mutated=true;
if(options.unpacked)raw.writeFileSync(archive+'.unpacked/'+options.fontRelative,'FONT');
else raw.utimesSync(archive,new Date(1000),new Date(2000));}return n;};
assert.throws(()=>Assets.ensureAssetsStaged({...input,force:true}),/source changed while reading/);
assert.equal(mutated,true,'The guarded read must encounter the source mutation');
fs.openSync=open;fs.readSync=read;
if(options.unpacked){
const updated=Assets.ensureAssetsStaged(input);assert.notEqual(updated.generationRoot,first.generationRoot);
assert.equal(fs.readFileSync(path.join(updated.generationRoot,'soundfont','GMGSx.SF2'),'utf8'),'FONT');
assert.equal(fs.readFileSync(path.join(first.generationRoot,'soundfont','GMGSx.SF2'),'utf8'),'font');
const physical=archive+'.unpacked/'+options.fontRelative;raw.unlinkSync(physical);raw.symlinkSync(path.join(options.kawarikiRoot,'preload.rb'),physical);
assert.throws(()=>Assets.getAssetsStatus(input),/real files and directories|symlinks/);
}
}
Assets.removeStagedAssets({userDataDir:options.userDataDir});
console.log(JSON.stringify({passed:true,virtualInodeChanged:true,unpacked:options.unpacked,unchangedCacheReads:warmSourceReads}));
`);
  return { runner, archive, fontRelative, userDataDir: path.join(root, "user"), kawarikiRoot, unpacked, heldStats };
}

for (const unpacked of [false, true]) test(`actual Electron ASAR ${unpacked ? "unpacked" : "packed"} assets preserve caching and source-race checks`, { skip: !available, timeout: 20000 }, async t => {
  const f = await fixture(t, unpacked);
  const result = spawnSync(electron, [f.runner, JSON.stringify(f)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout.trim()).passed, true);
});

for (const [unpacked, heldStats] of [[true, "rewrite"], [false, "rewrite"], [true, "descriptor-error"], [true, "backing-error"]])
  test(`actual Electron ASAR ${unpacked ? "unpacked" : "packed"} held coarse identity: ${heldStats}`, { skip: !available, timeout: 20000 }, async t => {
    const f = await fixture(t, unpacked, heldStats);
    const result = spawnSync(electron, [f.runner, JSON.stringify(f)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout.trim()).passed, true);
  });
