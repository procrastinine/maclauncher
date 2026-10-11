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

async function fixture(t, unpacked) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "maclauncher-rgss-asar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), moduleRoot = path.join(source, "src", "modules", "rgss");
  for (const relative of ["assets.js", "rgss-utils.js", "overlays/kawariki/patches-extra.rb"]) {
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
const Assets=require(archive+'/src/modules/rgss/assets.js'),input={userDataDir:options.userDataDir,kawarikiRoot:options.kawarikiRoot};
const rawMetadata=()=>{const s=raw.lstatSync(archive,{bigint:true});return [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].map(String);};
const before=rawMetadata(),virtualBefore=String(fs.lstatSync(font,{bigint:true}).ino),virtualAfter=String(fs.lstatSync(font,{bigint:true}).ino);
assert.notEqual(virtualBefore,virtualAfter,'Exercise actual Electron synthetic inode behavior');
const first=Assets.ensureAssetsStaged(input);assert.equal(first.assetsStaged,true);
const open=fs.openSync,read=fs.readSync,close=fs.closeSync,descriptors=new Set();let sourceReads=0;
fs.openSync=function(file,...args){const fd=open(file,...args);if(file===font)descriptors.add(fd);return fd;};
fs.readSync=function(fd,...args){if(descriptors.has(fd))sourceReads++;return read(fd,...args);};
fs.closeSync=function(fd){descriptors.delete(fd);return close(fd);};
for(let i=0;i<3;i++){const warm=Assets.ensureAssetsStaged(input);assert.equal(warm.generationRoot,first.generationRoot);assert.equal(warm.stagedNow,false);}
assert.equal(sourceReads,0,'Unchanged packaged files must reuse content hashes');
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
Assets.removeStagedAssets({userDataDir:options.userDataDir});
console.log(JSON.stringify({passed:true,virtualInodeChanged:true,unpacked:options.unpacked,unchangedCacheReads:warmSourceReads}));
`);
  return { runner, archive, fontRelative, userDataDir: path.join(root, "user"), kawarikiRoot, unpacked };
}

for (const unpacked of [false, true]) test(`actual Electron ASAR ${unpacked ? "unpacked" : "packed"} assets preserve caching and source-race checks`, { skip: !available, timeout: 20000 }, async t => {
  const f = await fixture(t, unpacked);
  const result = spawnSync(electron, [f.runner, JSON.stringify(f)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout.trim()).passed, true);
});
