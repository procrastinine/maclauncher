const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const Movie=require("../src/modules/shared/runtime/portable-ffmpeg");
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),"maclauncher-portable-movies-"));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function features(root){
  fs.writeFileSync(path.join(root,"config_components.h"),[["DECODER",Movie.PIN.decoders],["DEMUXER",Movie.PIN.demuxers],["PARSER",Movie.PIN.parsers]].flatMap(([kind,names])=>names.map(n=>`#define CONFIG_${n.toUpperCase()}_${kind} 1`)).join("\n")+"\n");
  fs.writeFileSync(path.join(root,"config.h"),["GPL","NONFREE","VERSION3","NETWORK","AVDEVICE","AVFILTER","ENCODERS"].map(n=>`#define CONFIG_${n} 0`).join("\n")+"\n");
}
test("portable movie profile retains MPEG video/audio plus raw MPEG demuxers without network or encoding",()=>{
  assert.ok(Movie.PIN.decoders.includes("mp2"));assert.ok(Movie.PIN.demuxers.includes("mpegvideo"));assert.ok(Movie.PIN.demuxers.includes("mpegtsraw"));assert.ok(Movie.OPTIONS.includes("--disable-network"));assert.ok(Movie.OPTIONS.includes("--disable-autodetect"));assert.ok(Movie.OPTIONS.includes("--disable-gpl"));assert.ok(Movie.OPTIONS.includes("--disable-programs"));assert.match(Movie.recipeIdentity(),/^[a-f0-9]{64}$/);
});
test("movie feature validation requires every selected codec and explicit disabled-feature declarations",t=>{
  const root=temporary(t);features(root);assert.equal(Movie.validateFeatures(root).network,false);
  const file=path.join(root,"config_components.h"),good=fs.readFileSync(file,"utf8");fs.writeFileSync(file,good.replace("CONFIG_MP2_DECODER 1","CONFIG_MP2_DECODER 0"));assert.throws(()=>Movie.validateFeatures(root),/mp2 decoder/);fs.writeFileSync(file,good);
  const cfg=path.join(root,"config.h"),config=fs.readFileSync(cfg,"utf8");fs.writeFileSync(cfg,config.replace("CONFIG_ENCODERS 0","CONFIG_ENCODERS 1"));assert.throws(()=>Movie.validateFeatures(root),/unselected feature/);fs.writeFileSync(cfg,config.replace("#define CONFIG_NETWORK 0\n",""));assert.throws(()=>Movie.validateFeatures(root),/omitted its declaration/);
});
test("movie diagnostic normalization maps complete prefixes and rejects unmapped private arguments",t=>{
  const root=temporary(t),file=path.join(root,"config.h");fs.writeFileSync(file,'#define FFMPEG_CONFIGURATION "--prefix=/build/nested/prefix -ffile-prefix-map=/build/nested=source"\n');
  Movie.normalizeDiagnostics(root,[{from:"/build",to:"generic"},{from:"/build/nested",to:"movies"}]);assert.match(fs.readFileSync(file,"utf8"),/--prefix=movies\/prefix/);assert.doesNotMatch(fs.readFileSync(file,"utf8"),/generic\/nested/);
  fs.writeFileSync(file,'#define FFMPEG_CONFIGURATION "--prefix=/home/example/build"\n');assert.throws(()=>Movie.normalizeDiagnostics(root,[]),/private build path/);
});
test("cancelled movie builds create no work directories",async t=>{
  const root=temporary(t),workRoot=path.join(root,"output");await assert.rejects(Movie.buildDependencies({workRoot,signal:AbortSignal.abort()}),{name:"AbortError"});assert.equal(fs.existsSync(workRoot),false);
});
test("untrusted movie archive identities fail before creating build outputs",async t=>{
  const root=temporary(t),archive=path.join(root,"archive.tar.xz"),workRoot=path.join(root,"output");fs.writeFileSync(archive,"untrusted");await assert.rejects(Movie.buildDependencies({archive,workRoot}),/exact source pin/);assert.equal(fs.existsSync(workRoot),false);
});
