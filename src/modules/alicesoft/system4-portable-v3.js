const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const Source = require("../shared/runtime/pinned-native-build");
const Native = require("../shared/runtime/local-native");
const Fonts = require("../shared/runtime/portable-sdl2-fonts");
const Audio = require("../shared/runtime/portable-sndfile");
const Movie = require("../shared/runtime/portable-ffmpeg");
const Prefix = require("./system35-portable");
const Overlay = require("./system4-portable-overlay-v3");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const PIN = Object.freeze(require("./system4-portable.json"));
const VERSION = "snapshot-de65718-macos-v3";
const REVISION = "de65718ba72d5eb291a4d0ddb691627f1d401909";
const LIBSYS4_REVISION = "e2bf438d0156a2ca70fc6018fddf7c870794a2ca";
const SOURCE_SHA256 = "3beeaf86056c10f4464c50cec45ed56a140a99443bec56e9930cbdbe09151acb";
const sourcePath = path.resolve(__dirname, "../../external/xsystem4");
const recipeFiles = [__filename, require.resolve("./system4-portable-overlay-v3"), require.resolve("./system4-portable.json"),
  require.resolve("./system35-portable"), require.resolve("./system35-overlay"), require.resolve("./system35-portable.json"),
  require.resolve("../shared/runtime/portable-sdl2-fonts"), require.resolve("../shared/runtime/portable-sdl2-fonts.json"),
  require.resolve("../shared/runtime/portable-sndfile"), require.resolve("../shared/runtime/portable-sndfile.json"),
  require.resolve("../shared/runtime/portable-ffmpeg"), require.resolve("../shared/runtime/portable-ffmpeg.json")];
function overlayIdentity() {
  const hash=crypto.createHash("sha256");for(const file of recipeFiles)hash.update(fs.readFileSync(file));return hash.digest("hex");
}
function dependencyRecipe(helper, catalog) {
  const hash=crypto.createHash("sha256").update(fs.readFileSync(require.resolve(helper)));
  if(catalog)hash.update(fs.readFileSync(require.resolve(catalog)));return hash.digest("hex");
}

function validateMovieStack(stack) {
  if (!stack || stack.architecture !== "arm64" || stack.minimumMacOS !== "13.0" ||
      stack.version !== Movie.PIN.version || stack.recipeSha256 !== Movie.recipeIdentity() ||
      !isDeepStrictEqual(stack.source,Movie.PIN.source) || !isDeepStrictEqual(stack.decoders,Movie.PIN.decoders) || !isDeepStrictEqual(stack.demuxers,Movie.PIN.demuxers) ||
      !/^[a-f0-9]{64}$/.test(stack.prefixSha256||"") || stack.network !== false || stack.externalCodecs !== false || stack.gpl !== false || stack.nonfree !== false ||
      !Array.isArray(stack.options) || !isDeepStrictEqual(stack.options.slice(7,-2),Movie.OPTIONS)) {
    throw new Error("Portable movie reuse needs the exact source recipe, codec profile and prefix checksum.");
  }
  const configuredPrefix=stack.options.find(option=>option.startsWith("--prefix="))?.slice(9);
  if(!configuredPrefix || fs.realpathSync(configuredPrefix)!==fs.realpathSync(stack.prefix))throw new Error("Portable movie metadata must reference its original library prefix.");
  const inventory=Prefix.snapshotPrefix(stack.prefix);
  if(inventory.sha256!==stack.prefixSha256)throw new Error("Portable movie dependency prefix checksum changed.");
  return inventory;
}

function nativeFile({ prefix, sdk, pathMappings, tools }) {
  for(const value of [prefix,sdk,...Object.values(tools)]) if(!path.isAbsolute(value||"")||/[\r\n\0]/.test(value))throw new Error("Portable Meson build paths must be absolute.");
  const flags=Audio.compilerFlags(sdk,pathMappings).split(" ");
  const quote=value=>"'"+value.replaceAll("\\","\\\\").replaceAll("'","\\'")+"'";
  const list=values=>"["+values.map(quote).join(", ")+"]";
  return "[binaries]\n"+Object.entries({c:"/usr/bin/clang",cpp:"/usr/bin/clang++",ar:"/usr/bin/ar",strip:"/usr/bin/strip",'pkg-config':tools.pkgconfig,bison:tools.bison,flex:tools.flex}).map(([key,value])=>key+" = "+quote(value)).join("\n")+
    "\n[built-in options]\nc_args = "+list(flags)+"\nc_link_args = "+list(["-arch","arm64","-mmacosx-version-min=13.0","-isysroot",sdk,"-Wl,-headerpad_max_install_names","-Wl,-rpath,"+path.join(prefix,"lib")])+"\ncmake_prefix_path = []\npkg_config_path = []\n";
}

function validateFeatures(outputRoot) {
  const commands=JSON.parse(fs.readFileSync(path.join(outputRoot,"compile_commands.json"),"utf8"));
  if(!Array.isArray(commands)||commands.length>2000)throw new Error("Invalid xsystem4 compilation inventory.");
  const files=commands.map(row=>path.basename(row.file));
  for(const name of ["debug.c","debugger_dap.c","movie_ffmpeg.c"])if(!files.includes(name))throw new Error("xsystem4 did not compile its selected debugger/movie profile.");
  if(files.some(name=>["movie_plmpeg.c","debugger_scm.c"].includes(name))||commands.some(row=>/HAVE_SCHEME|HAVE_READLINE|(?:-I|-L)\s?\/(?:opt\/homebrew|usr\/local)/.test(row.command||"")))throw new Error("xsystem4 enabled an unselected dependency.");
  return {debugger:true,debugAdapter:true,schemeDebugger:false,readline:false,appleOpenGL:"3.2 core",glsl:"150",webp:true,jpeg:true,
    audioFormats:Audio.PIN.audioFormats,movieVersion:Movie.PIN.source.version,movieDecoders:Movie.PIN.decoders,movieDemuxers:Movie.PIN.demuxers,movieNetwork:false,movieExternalCodecs:false};
}

async function buildPortableSystem4({ sourceDir=sourcePath,archives,workRoot,dependencyStacks,pathMappings=[],signal,onProgress,dependencies={} }) {
  throwIfAborted(signal);
  if(process.platform!=="darwin"||process.arch!=="arm64")throw new Error("This portable xsystem4 build requires an Apple Silicon Mac.");
  workRoot=Fonts.assertFreshBuildRoot(workRoot,{readOnlyRoots:[sourceDir,...Object.values(dependencyStacks||{}).map(stack=>stack.prefix)]});
  Fonts.validateArchives(archives);Audio.validateArchives(archives);Audio.validateArchives(archives,{catalog:PIN});
  if(!path.isAbsolute(archives?.ffmpeg||"")||Native.hashFile(archives.ffmpeg)!==Movie.PIN.source.sha256)throw new Error("Portable movies require the exact FFmpeg source archive.");
  const source=await Source.validatePinnedSource(sourceDir,REVISION,{signal});
  if(Source.hashPinnedFiles(sourceDir,source.files)!==SOURCE_SHA256)throw new Error("xsystem4 and libsys4 source checksum differs from the selected version.");
  const overlaySha256=overlayIdentity(),retained=[];
  let fonts,audio,movie;
  if(dependencyStacks){
    if(Object.keys(dependencyStacks).length!==3||!dependencyStacks.fonts||!dependencyStacks.audio||!dependencyStacks.movie)throw new Error("Portable dependency reuse needs font, audio and movie profiles.");
    ({fonts,audio,movie}=dependencyStacks);
    retained.push(Prefix.validateStack(fonts,Fonts.PIN,dependencyRecipe("../shared/runtime/portable-sdl2-fonts","../shared/runtime/portable-sdl2-fonts.json")),
      Prefix.validateStack(audio,Audio.PIN,dependencyRecipe("../shared/runtime/portable-sndfile","../shared/runtime/portable-sndfile.json")),validateMovieStack(movie));
  }
  fs.mkdirSync(workRoot,{recursive:true});
  if(!fonts){
    fonts=await Fonts.buildDependencies({archives,workRoot:path.join(workRoot,"font-dependencies"),pathMappings,signal,onProgress,dependencies});
    audio=await Audio.buildDependencies({archives,workRoot:path.join(workRoot,"audio-dependencies"),pathMappings,signal,onProgress,dependencies});
    movie=await Movie.buildDependencies({archive:archives.ffmpeg,workRoot:path.join(workRoot,"movie-dependencies"),pathMappings,signal,onProgress,dependencies});
  }
  if(fonts.sdk!==audio.sdk||fonts.sdk!==movie.sdk)throw new Error("Portable dependency profiles must use the same macOS SDK.");
  const prefix=path.join(workRoot,"prefix"),sourceRoots={},sources=[];fs.mkdirSync(prefix);
  Prefix.linkPrefix(fonts.prefix,prefix);Prefix.linkPrefix(audio.prefix,prefix);Prefix.linkPrefix(movie.prefix,prefix);
  const find=dependencies.findBuildTool||Source.findBuildTool;
  const tools={...fonts.tools,meson:find("meson"),pkgconfig:find("pkg-config"),bison:find("bison"),flex:find("flex")};
  // Tool-only keg paths are explicit; runtime dependencies are prefix-confined.
  for(const name of ["bison","flex"]){for(const root of ["/opt/homebrew/opt","/usr/local/opt"]){const file=path.join(root,name,"bin",name);try{fs.accessSync(file,fs.constants.X_OK);tools[name]=file;break;}catch{}}}
  const run=dependencies.runBuildCommand||Source.runBuildCommand,env=Fonts.buildEnvironment(prefix,fonts.sdk);
  for(const pin of PIN.dependencies){
    throwIfAborted(signal);const sourceRoot=path.join(workRoot,"source",pin.id);fs.mkdirSync(sourceRoot,{recursive:true});
    await run("/usr/bin/tar",["-xf",archives[pin.id],"--strip-components","1","-C",sourceRoot],{cwd:workRoot,logPath:path.join(workRoot,"extraction.log"),env,signal});
    for(const notice of pin.notices)if(!fs.lstatSync(path.join(sourceRoot,notice)).isFile())throw new Error("Missing source license for "+pin.name);
    onProgress?.({phase:"build",project:pin.id});
    const common={sourceRoot:path.join(sourceRoot,pin.sourceSubdirectory||""),outputRoot:path.join(workRoot,pin.id),prefix,sdk:fonts.sdk,pathMappings,options:pin.options,signal,dependencies};
    const build=await(pin.buildSystem==="autotools"?Audio.buildAutotools(common):Fonts.buildProject({...common,tools,onProgress}));
    sources.push({...pin,...build,sourceRoot});sourceRoots[pin.id]=sourceRoot;
  }
  const sourceRoot=path.join(workRoot,"xsystem4-source"),sourceTreeSha256=Source.stagePinnedFiles(sourceDir,source.files,sourceRoot);
  const sourceOverlay=Overlay.apply(sourceRoot,{sourceDir,version:VERSION});
  const buildFile=path.join(workRoot,"native.ini");fs.writeFileSync(buildFile,nativeFile({prefix,sdk:fonts.sdk,pathMappings,tools}));
  const outputRoot=path.join(workRoot,"xsystem4"),logPath=path.join(workRoot,"xsystem4.log"),startedAt=new Date().toISOString();
  env.GIT_CEILING_DIRECTORIES=workRoot;
  const configureOptions=["setup",outputRoot,sourceRoot,"--native-file",buildFile,"--wrap-mode=nodownload","--buildtype=release","--prefix",prefix,
    "-Dopengles=disabled","-Ddebugger=enabled","-Dscheme=disabled","-Dreadline=disabled","-Dffmpeg=enabled"];
  await run(tools.meson,configureOptions,{cwd:workRoot,logPath,env,signal});
  await run(tools.ninja,["-C",outputRoot,"-j2"],{cwd:workRoot,logPath,env,signal});
  await run(tools.meson,["install","-C",outputRoot,"--no-rebuild"],{cwd:workRoot,logPath,env,signal});
  throwIfAborted(signal);const features=validateFeatures(outputRoot);
  await Source.validatePinnedSource(sourceDir,REVISION,{signal});
  if(Source.hashPinnedFiles(sourceDir,source.files)!==sourceTreeSha256||overlayIdentity()!==overlaySha256)throw new Error("xsystem4 source or build adapter changed during compilation.");
  for(const inventory of retained)if(Prefix.snapshotPrefix(inventory.prefix).sha256!==inventory.sha256)throw new Error("A reused dependency prefix changed during compilation.");
  const executable=path.join(prefix,"bin/xsystem4");
  return {managerId:"xsystem4",version:VERSION,sourceRevision:REVISION,libsys4Revision:LIBSYS4_REVISION,sourceTreeSha256,overlaySha256,sourceOverlay,
    architecture:"arm64",minimumMacOS:"13.0",executable,executableSha256:Native.hashFile(executable),resources:path.join(prefix,"share/xsystem4"),features,
    sourceRoot,outputRoot,prefix,sdk:fonts.sdk,tools,configureOptions,startedAt,completedAt:new Date().toISOString(),logPath,
    dependencyClosure:{version:PIN.version,prefix,fonts,audio,movie,sources,sourceRoots,reusedPrefixes:retained.map(({prefix:directory,sha256})=>({prefix:directory,sha256}))}};
}
module.exports={VERSION,REVISION,LIBSYS4_REVISION,SOURCE_SHA256,PIN,sourcePath,recipeFiles,overlayIdentity,dependencyRecipe,validateMovieStack,nativeFile,validateFeatures,buildPortableSystem4};
