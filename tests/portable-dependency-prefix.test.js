const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const Prefix=require("../src/modules/shared/runtime/portable-dependency-prefix"),Mixer=require("../src/modules/shared/runtime/portable-sdl2-mixer");
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-prefix-test-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test("dependency linking preserves original libraries and requires explicit confined read roots",t=>{
  const root=temporary(t),original=path.join(root,"original"),prefix=path.join(root,"prefix"),output=path.join(root,"output"),outside=path.join(root,"outside");for(const p of [original,prefix,output,outside])fs.mkdirSync(path.join(p,"lib"),{recursive:true});
  fs.writeFileSync(path.join(original,"lib/library"),"bytes");fs.symlinkSync(path.join(original,"lib/library"),path.join(prefix,"lib/library"));
  assert.throws(()=>Prefix.snapshotPrefix(prefix),/declared prefixes/);assert.throws(()=>Prefix.linkPrefix(prefix,output),/declared regular files/);
  const before=Prefix.snapshotPrefix(original);Prefix.linkPrefix(prefix,output,{readRoots:[original]});const linked=Prefix.snapshotPrefix(output,{readRoots:[original]});assert.equal(linked.files.length,1);assert.equal(linked.files[0].sha256,before.files[0].sha256);assert.equal(Prefix.snapshotPrefix(original).sha256,before.sha256);
  fs.writeFileSync(path.join(outside,"lib/escape"),"outside");fs.symlinkSync(path.join(outside,"lib/escape"),path.join(prefix,"lib/escape"));assert.throws(()=>Prefix.snapshotPrefix(prefix,{readRoots:[original]}),/declared prefixes/);
});
test("dependency prefix identity detects same-size changed bytes even with restored modification time",t=>{
  const root=temporary(t),prefix=path.join(root,"prefix");fs.mkdirSync(prefix);const file=path.join(prefix,"library");fs.writeFileSync(file,"alpha");const stat=fs.statSync(file),before=Prefix.snapshotPrefix(prefix).sha256;fs.writeFileSync(file,"bravo");fs.utimesSync(file,stat.atime,stat.mtime);assert.notEqual(Prefix.snapshotPrefix(prefix).sha256,before);
});
test("Opus descriptor correction replaces a linked descriptor instead of changing its source",t=>{
  const root=temporary(t),original=path.join(root,"opus.pc"),prefix=path.join(root,"prefix");fs.mkdirSync(path.join(prefix,"lib/pkgconfig"),{recursive:true});fs.writeFileSync(original,"Name: opus\nVersion: 0\n");fs.symlinkSync(original,path.join(prefix,"lib/pkgconfig/opus.pc"));Mixer.adaptOpusDescriptor(prefix);assert.equal(fs.readFileSync(original,"utf8"),"Name: opus\nVersion: 0\n");assert.equal(fs.lstatSync(path.join(prefix,"lib/pkgconfig/opus.pc")).isFile(),true);assert.match(fs.readFileSync(path.join(prefix,"lib/pkgconfig/opus.pc"),"utf8"),/Version: 1\.6\.1/);
});
test("audio profile refuses accidental dynamic codecs and cancelled builds before writes",async t=>{
  const root=temporary(t);fs.mkdirSync(path.join(root,"sdl2_mixer"));const file=path.join(root,"sdl2_mixer/compile_commands.json");fs.writeFileSync(file,JSON.stringify(["MUSIC_MID_NATIVE MUSIC_FLAC_LIBFLAC MUSIC_MP3_MPG123 MUSIC_OPUS MUSIC_OGG"]));assert.equal(Mixer.validateFeatures(root).dynamicCodecLoading,false);fs.appendFileSync(file," MPG123_DYNAMIC");assert.throws(()=>Mixer.validateFeatures(root),/unselected dynamic codec/);const workRoot=path.join(root,"output");await assert.rejects(Mixer.buildMixer({workRoot,signal:AbortSignal.abort()}),{name:"AbortError"});assert.equal(fs.existsSync(workRoot),false);
});
