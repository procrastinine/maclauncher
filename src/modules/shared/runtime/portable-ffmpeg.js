const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const Source = require("./pinned-native-build");
const Native = require("./local-native");
const Portable = require("./portable-sdl2-fonts");
const Audio = require("./portable-sndfile");
const { throwIfAborted } = require("./download-utils");
const PIN = Object.freeze(require("./portable-ffmpeg.json"));
const OPTIONS = Object.freeze(["--enable-shared", "--disable-static", "--enable-pic", "--disable-doc", "--disable-debug", "--disable-autodetect",
  "--disable-gpl", "--disable-nonfree", "--disable-version3", "--disable-everything", "--disable-programs", "--disable-network", "--disable-avdevice", "--disable-avfilter",
  "--enable-zlib", "--enable-decoder=" + PIN.decoders.join(","), "--enable-demuxer=" + PIN.demuxers.join(","), "--enable-parser=" + PIN.parsers.join(","), "--enable-protocol=file"]);
function recipeIdentity() {
  return crypto.createHash("sha256").update(fs.readFileSync(__filename)).update(fs.readFileSync(require.resolve("./portable-ffmpeg.json"))).digest("hex");
}
function normalizeDiagnostics(outputRoot, pathMappings) {
  const file=path.join(outputRoot,"config.h"), original=fs.readFileSync(file,"utf8");let found=false;
  const adapted=original.replace(/^#define FFMPEG_CONFIGURATION (.*)$/m,(_line,value)=>{
    found=true;for(const {from,to} of [...pathMappings].sort((a,b)=>b.from.length-a.from.length))value=value.split(from).join(to);
    if(/\/(?:Users|Volumes|home)\/|\.local\//.test(value))throw new Error("FFmpeg configuration retains a private build path.");
    return "#define FFMPEG_CONFIGURATION "+value;
  });
  if(!found)throw new Error("FFmpeg configuration diagnostic is missing.");
  fs.writeFileSync(file,adapted);return {path:"config.h",sha256:Native.hashFile(file)};
}
function validateFeatures(outputRoot) {
  const components=fs.readFileSync(path.join(outputRoot,"config_components.h"),"utf8"),config=fs.readFileSync(path.join(outputRoot,"config.h"),"utf8");
  for(const [kind,names] of [["DECODER",PIN.decoders],["DEMUXER",PIN.demuxers],["PARSER",PIN.parsers]]){
    for(const name of names)if(!new RegExp(`^#define CONFIG_${name.toUpperCase()}_${kind} 1$`,"m").test(components))throw new Error(`FFmpeg did not compile the selected ${name} ${kind.toLowerCase()}.`);
  }
  for(const name of ["GPL","NONFREE","VERSION3","NETWORK","AVDEVICE","AVFILTER","ENCODERS"]){
    if(!new RegExp(`^#define CONFIG_${name} 0$`,"m").test(config))throw new Error("FFmpeg enabled an unselected feature or omitted its declaration.");
  }
  return {decoders:PIN.decoders,demuxers:PIN.demuxers,parsers:PIN.parsers,network:false,externalCodecs:false,gpl:false,nonfree:false,programs:false};
}
async function buildDependencies({archive,workRoot,pathMappings=[],signal,onProgress,dependencies={}}={}) {
  throwIfAborted(signal);
  if(process.platform!=="darwin"||process.arch!=="arm64")throw new Error("This portable movie build requires an Apple Silicon Mac.");
  if(!path.isAbsolute(archive||"")||!fs.lstatSync(archive).isFile()||fs.statSync(archive).size!==PIN.source.bytes||Native.hashFile(archive)!==PIN.source.sha256)throw new Error("The FFmpeg source archive differs from its exact source pin.");
  workRoot=Portable.assertFreshBuildRoot(workRoot,{readOnlyRoots:[path.dirname(archive)]});
  const sdk=(dependencies.readSDK||(()=>execFileSync("/usr/bin/xcrun",["--show-sdk-path"],{encoding:"utf8"}).trim()))();
  const mappings=[...pathMappings,{from:workRoot,to:"portable-movies"}],flags=Audio.compilerFlags(sdk,mappings),overlaySha256=recipeIdentity();
  fs.mkdirSync(workRoot,{recursive:true});const sourceRoot=path.join(workRoot,"source"),outputRoot=path.join(workRoot,"output"),prefix=path.join(workRoot,"prefix");
  fs.mkdirSync(sourceRoot);fs.mkdirSync(outputRoot);fs.mkdirSync(prefix);
  const run=dependencies.runBuildCommand||Source.runBuildCommand,env=Portable.buildEnvironment(prefix,sdk),logPath=path.join(workRoot,"build.log");
  await run("/usr/bin/tar",["-xf",archive,"--strip-components","1","-C",sourceRoot],{cwd:workRoot,logPath,env,signal});
  for(const name of PIN.source.notices)if(!fs.lstatSync(path.join(sourceRoot,name)).isFile())throw new Error("FFmpeg source notice is missing.");
  const options=[`--prefix=${prefix}`,"--arch=arm64","--target-os=darwin","--cc=/usr/bin/clang","--cxx=/usr/bin/clang++","--host-cc=/usr/bin/clang",`--sysroot=${sdk}`,...OPTIONS,
    "--extra-cflags="+flags,`--extra-ldflags=-arch arm64 -mmacosx-version-min=13.0 -isysroot ${sdk} -Wl,-headerpad_max_install_names -Wl,-rpath,${prefix}/lib`];
  const startedAt=new Date().toISOString();onProgress?.({phase:"configure",project:"ffmpeg"});
  await run(path.join(sourceRoot,"configure"),options,{cwd:outputRoot,env,logPath,signal});
  const diagnostics=normalizeDiagnostics(outputRoot,mappings);
  await run("/usr/bin/make",["-j2"],{cwd:outputRoot,env,logPath,signal,timeout:20*60*1000});
  await run("/usr/bin/make",["install"],{cwd:outputRoot,env,logPath,signal});throwIfAborted(signal);
  const features=validateFeatures(outputRoot);
  if(recipeIdentity()!==overlaySha256)throw new Error("Portable movie recipe changed during compilation.");
  return {version:PIN.version,source:PIN.source,architecture:PIN.architecture,minimumMacOS:PIN.minimumMacOS,recipeSha256:overlaySha256,prefix,sdk,sourceRoot,outputRoot,options,diagnostics,
    startedAt,completedAt:new Date().toISOString(),logPath,...features};
}
module.exports={PIN,OPTIONS,recipeIdentity,normalizeDiagnostics,validateFeatures,buildDependencies};
