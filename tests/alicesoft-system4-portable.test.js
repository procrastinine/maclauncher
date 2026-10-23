const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Portable = require("../src/modules/alicesoft/system4-portable");
const CurrentPortable = require("../src/modules/alicesoft/system4-portable-v3");
const Overlay = require("../src/modules/alicesoft/system4-portable-overlay");
const Prefix = require("../src/modules/alicesoft/system35-portable");
const Movie = require("../src/modules/shared/runtime/portable-ffmpeg");
function temporary(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-system4-portable-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;
}
function inputs(t) {
  if(!fs.existsSync(path.join(Portable.sourcePath,"src/util.c"))){t.skip("xsystem4 source submodule is not initialized");return null;}
  const root=temporary(t),source=path.join(root,"source");
  for(const relative of Object.keys(Overlay.SOURCE_HASHES)){fs.mkdirSync(path.dirname(path.join(source,relative)),{recursive:true});fs.copyFileSync(path.join(Portable.sourcePath,relative),path.join(source,relative));}
  return{root,source};
}
test("System4 portable overlay preserves upstream and declares exact dependency choices",t=>{
  const fixture=inputs(t);if(!fixture)return;
  const originals=Object.keys(Overlay.SOURCE_HASHES).map(r=>fs.readFileSync(path.join(Portable.sourcePath,r)));
  const result=Overlay.apply(fixture.source);assert.equal(result.files.length,8);
  const meson=fs.readFileSync(path.join(fixture.source,"meson.build"),"utf8");
  assert.match(meson,/appleframeworks.*OpenGL/);assert.match(meson,/required : get_option\('scheme'\)/);assert.match(meson,/required: get_option\('ffmpeg'\)/);assert.doesNotMatch(meson,/fallback : \['cglm'/);
  const video=fs.readFileSync(path.join(fixture.source,"src/video.c"),"utf8");assert.match(video,/#version 150/);assert.match(video,/xsys4_resource_path/);
  const font=fs.readFileSync(path.join(fixture.source,"src/text.c"),"utf8");assert.ok(font.indexOf("// user specified font")<font.indexOf("xsys4_resource_path(runtime_font"));
  assert.match(fs.readFileSync(path.join(fixture.source,"src/meson.build"),"utf8"),/snapshot-04333ad-macos-v2/);
  Object.keys(Overlay.SOURCE_HASHES).forEach((r,i)=>assert.deepEqual(fs.readFileSync(path.join(Portable.sourcePath,r)),originals[i]));
  assert.throws(()=>Overlay.apply(Portable.sourcePath),/separate writable/);
});
test("all System4 overlay inputs are validated before mutation and external links are refused",t=>{
  const f=inputs(t);if(!f)return;const first=fs.readFileSync(path.join(f.source,"meson.build"));
  fs.writeFileSync(path.join(f.source,"src/util.c"),"changed");assert.throws(()=>Overlay.apply(f.source),/checksum/);assert.deepEqual(fs.readFileSync(path.join(f.source,"meson.build")),first);
  fs.unlinkSync(path.join(f.source,"src/util.c"));fs.symlinkSync(path.join(Portable.sourcePath,"src/util.c"),path.join(f.source,"src/util.c"));assert.throws(()=>Overlay.apply(f.source),/contained regular/);
  assert.throws(()=>Overlay.adapt("src/util.c",Buffer.from("wrong")),/checksum/);
  assert.throws(()=>Overlay.adapt("meson.build",first,{version:"bad'version"}),/Invalid.*version/);
});
test("native System4 resources follow a relocated executable, confine names and handle short buffers",{skip:process.platform!=="darwin"||process.arch!=="arm64"},t=>{
  const root=temporary(t),runtime=path.join(root,"Runtime With Spaces.app/Contents/Resources/engine/files"),exe=path.join(runtime,"bin/probe");
  fs.mkdirSync(path.dirname(exe),{recursive:true});for(const relative of ["fonts/VL-Gothic-Regular.ttf","fonts/HanaMinA.ttf","shaders/default.f.glsl"]){const f=path.join(runtime,"share/xsystem4",relative);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,"asset");}
  const header="#include <stdio.h>\n#include <stdbool.h>\n#include <stdlib.h>\n#include <string.h>\n#include <stdint.h>\n#include <limits.h>\n#include <mach-o/dyld.h>\n";
  const main='int main(void){char out[PATH_MAX];const char* files[]={"fonts/VL-Gothic-Regular.ttf","fonts/HanaMinA.ttf","shaders/default.f.glsl"};for(int i=0;i<3;i++){if(!xsys4_resource_path(out,sizeof(out),files[i]))return 1;FILE*f=fopen(out,"rb");if(!f)return 2;fclose(f);}const char* bad[]={"","/absolute","../escape","shaders/../escape","shaders//empty","./relative","shaders/","a\\\\b"};for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);i++){if(xsys4_resource_path(out,sizeof(out),bad[i]))return 3;}if(xsys4_resource_path(out,2,files[0])||xsys4_resource_path(NULL,sizeof(out),files[0]))return 4;return 0;}';
  const file=path.join(root,"probe.c");fs.writeFileSync(file,header+Overlay.RESOURCE_FUNCTION+main);
  execFileSync("/usr/bin/clang",["-arch","arm64","-mmacosx-version-min=13.0",file,"-o",exe],{timeout:30000,stdio:"pipe"});
  execFileSync(exe,[],{cwd:os.tmpdir(),timeout:10000,stdio:"pipe"});const alias=path.join(root,"alias");fs.symlinkSync(exe,alias);execFileSync(alias,[],{cwd:os.tmpdir(),timeout:10000,stdio:"pipe"});
});
test("movie dependency reuse rejects source/profile/configured-prefix drift and byte mutations",t=>{
  const root=temporary(t),prefix=path.join(root,"prefix");fs.mkdirSync(path.join(prefix,"lib"),{recursive:true});fs.writeFileSync(path.join(prefix,"lib/avcodec"),"codec");
  const stack={version:Movie.PIN.version,source:Movie.PIN.source,architecture:"arm64",minimumMacOS:"13.0",recipeSha256:Movie.recipeIdentity(),prefix,prefixSha256:Prefix.snapshotPrefix(prefix).sha256,decoders:Movie.PIN.decoders,demuxers:Movie.PIN.demuxers,options:["--prefix="+prefix,"--arch=arm64","--target-os=darwin","--cc=/usr/bin/clang","--cxx=/usr/bin/clang++","--host-cc=/usr/bin/clang","--sysroot=/SDK",...Movie.OPTIONS,"--extra-cflags=flags","--extra-ldflags=flags"],network:false,externalCodecs:false,gpl:false,nonfree:false};
  assert.equal(Portable.validateMovieStack(stack).sha256,stack.prefixSha256);
  assert.throws(()=>Portable.validateMovieStack({...stack,decoders:Movie.PIN.decoders.slice(1)}),/exact source recipe/);
  assert.throws(()=>Portable.validateMovieStack({...stack,minimumMacOS:"27.0"}),/exact source recipe/);
  assert.throws(()=>Portable.validateMovieStack({...stack,options:["--prefix="+root,...stack.options.slice(1)]}),/original library prefix/);
  fs.writeFileSync(path.join(prefix,"lib/avcodec"),"changed");assert.throws(()=>Portable.validateMovieStack(stack),/prefix checksum changed/);
});
test("Meson compiler settings pin architecture, SDK, package tools and source-path maps",()=>{
  const settings=Portable.nativeFile({prefix:"/tmp/build/prefix",sdk:"/SDK",pathMappings:[{from:"/tmp/build",to:"source-build"}],tools:{pkgconfig:"/tools/pkg-config",bison:"/tools/bison",flex:"/tools/flex"}});
  assert.match(settings,/c = '\/usr\/bin\/clang'/);assert.match(settings,/'-arch', 'arm64'/);assert.match(settings,/-mmacosx-version-min=13\.0/);assert.match(settings,/pkg_config_path = \[\]/);assert.match(settings,/-fmacro-prefix-map=\/tmp\/build=source-build/);
  assert.throws(()=>Portable.nativeFile({prefix:"/tmp/prefix",sdk:"/SDK",tools:{pkgconfig:"relative",bison:"/tools/bison",flex:"/tools/flex"}}),/absolute/);
});
test("System4 feature validation refuses missing movies/debugger and unselected external support",t=>{
  const root=temporary(t),file=path.join(root,"compile_commands.json");
  const good=["debug.c","debugger_dap.c","movie_ffmpeg.c"].map(name=>({file:"/source/"+name,command:"/usr/bin/clang -DDEBUGGER_ENABLED"}));fs.writeFileSync(file,JSON.stringify(good));
  assert.equal(Portable.validateFeatures(root).movieVersion,"7.1.2");assert.equal(Portable.validateFeatures(root).debugAdapter,true);
  fs.writeFileSync(file,JSON.stringify(good.slice(0,2)));assert.throws(()=>Portable.validateFeatures(root),/selected debugger\/movie/);
  fs.writeFileSync(file,JSON.stringify([...good,{file:"/source/a.c",command:"cc -I/opt/homebrew/include"}]));assert.throws(()=>Portable.validateFeatures(root),/unselected dependency/);
  fs.writeFileSync(file,JSON.stringify([...good,{file:"/source/debugger_scm.c",command:"cc"}]));assert.throws(()=>Portable.validateFeatures(root),/unselected dependency/);
});
test("cancelled portable System4 build has no output side effects and retains explicit source identities",async t=>{
  const root=temporary(t),workRoot=path.join(root,"output"),signal=AbortSignal.abort();
  await assert.rejects(Portable.buildPortableSystem4({workRoot,signal}),{name:"AbortError"});assert.equal(fs.existsSync(workRoot),false);
  assert.equal(Portable.LIBSYS4_REVISION,"20560d4d6d41a7196bd6b8409bcbb974f9de4af0");assert.match(Portable.overlayIdentity(),/^[a-f0-9]{64}$/);assert.equal(Portable.PIN.dependencies.length,5);
  const ffi=Portable.PIN.dependencies.find(p=>p.id==="libffi");assert.equal(ffi.version,"3.8.0");assert.equal(ffi.archiveSha256.length,64);
});

test("current System4 snapshot remains a distinct exact source choice beside the retained default", async t => {
  const root = temporary(t), workRoot = path.join(root, "current-output");
  await assert.rejects(CurrentPortable.buildPortableSystem4({ workRoot, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.equal(fs.existsSync(workRoot), false);
  assert.equal(CurrentPortable.REVISION, "de65718ba72d5eb291a4d0ddb691627f1d401909");
  assert.equal(CurrentPortable.LIBSYS4_REVISION, "e2bf438d0156a2ca70fc6018fddf7c870794a2ca");
  const manager = require("../src/modules/alicesoft/main").runtimeManagers.find(item => item.id === "xsystem4");
  assert.equal(manager.getState({}).catalog.recommendedVersion, null);
  const snapshot = manager.core.catalog.find(row => row.version === "MCLv1-1021");
  assert.equal(snapshot.upstreamRevision, CurrentPortable.REVISION);
  assert.equal(snapshot.sourceTreeSha256, CurrentPortable.SOURCE_SHA256);
  assert.equal(snapshot.minimumMacOS, "13.0");
});
