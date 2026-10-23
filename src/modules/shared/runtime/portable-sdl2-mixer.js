const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Source = require("./pinned-native-build");
const Native = require("./local-native");
const Fonts = require("./portable-sdl2-fonts");
const Audio = require("./portable-sndfile");
const Prefix = require("./portable-dependency-prefix");
const { throwIfAborted } = require("./download-utils");
const PIN = Object.freeze(require("./portable-sdl2-mixer.json"));
const MIXER_CMAKE_SHA256 = "c14000d099bb2135ef7994dce44adad1f6dfa9b35a21f28d75476d5b001a0e08";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const dependencyRecipe = (helper, catalog) => crypto.createHash("sha256").update(fs.readFileSync(require.resolve(helper))).update(fs.readFileSync(require.resolve(catalog))).digest("hex");
const recipeIdentity = () => digest(Buffer.concat([fs.readFileSync(__filename),fs.readFileSync(require.resolve("./portable-sdl2-mixer.json")),fs.readFileSync(require.resolve("./portable-dependency-prefix"))]));

function adaptMixer(sourceRoot) {
  const file = path.join(sourceRoot, "CMakeLists.txt");
  if (!path.isAbsolute(sourceRoot || "") || !fs.lstatSync(sourceRoot).isDirectory() || !fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(sourceRoot) + path.sep)) throw new Error("SDL2_mixer adapters require a separate contained source directory.");
  const external = path.resolve(__dirname, "../../../external"), root = fs.realpathSync(sourceRoot);
  if (root === external || root.startsWith(external + path.sep)) throw new Error("SDL2_mixer adapters cannot change source checkouts.");
  const original = fs.readFileSync(file), text = original.toString("utf8"), target = "        find_package(FLAC REQUIRED)";
  if (digest(original) !== MIXER_CMAKE_SHA256 || text.indexOf(target) !== text.lastIndexOf(target) || !text.includes(target)) throw new Error("SDL2_mixer source differs from the selected adapter.");
  const adapted = Buffer.from(text.replace(target, "        find_package(Threads REQUIRED)\n" + target)); fs.writeFileSync(file, adapted);
  return { path: "CMakeLists.txt", sourceSha256: MIXER_CMAKE_SHA256, adaptedSourceSha256: digest(adapted) };
}

function adaptOpusDescriptor(prefix) {
  const pin = Audio.PIN.dependencies.find(row => row.id === "opus"), file = path.join(prefix,"lib/pkgconfig/opus.pc"), original = fs.readFileSync(file), text=original.toString("utf8");
  if (!["0",pin.version].includes(/^Version:\s*([^\r\n]+)$/m.exec(text)?.[1])) throw new Error("Opus metadata differs from the selected source version.");
  const adapted=Buffer.from(text.replace(/^Version:[^\r\n]+/m,`Version: ${pin.version}`)), temporary=file+".new";
  fs.writeFileSync(temporary,adapted,{flag:"wx"});try{fs.renameSync(temporary,file);}finally{fs.rmSync(temporary,{force:true});}
  return { path:"lib/pkgconfig/opus.pc", sourceRevision:pin.revision, version:pin.version, sourceSha256:digest(original), adaptedSha256:digest(adapted) };
}

function validateFeatures(outputRoot) {
  const commands=fs.readFileSync(path.join(outputRoot,"sdl2_mixer/compile_commands.json"),"utf8");
  for(const name of ["MUSIC_MID_NATIVE","MUSIC_FLAC_LIBFLAC","MUSIC_MP3_MPG123","MUSIC_OPUS","MUSIC_OGG"]) if(!commands.includes(name))throw new Error(`SDL2_mixer did not enable ${name}.`);
  if(/(?:FLAC|MPG123|OPUS|OGG)_DYNAMIC|MUSIC_MID_FLUIDSYNTH|MUSIC_MID_TIMIDITY/.test(commands))throw new Error("SDL2_mixer enabled an unselected dynamic codec or MIDI backend.");
  return {audioFormats:["WAV","AIFF","FLAC","Ogg Vorbis","Ogg Opus","MP3","MIDI"],midi:"macOS AudioToolbox",dynamicCodecLoading:false};
}

async function buildMixer({archives,workRoot,dependencyStacks,pathMappings=[],signal,onProgress,dependencies={}}) {
  throwIfAborted(signal);
  workRoot=Fonts.assertFreshBuildRoot(workRoot,{readOnlyRoots:Object.values(dependencyStacks||{}).map(stack=>stack.prefix)});
  Fonts.validateArchives(archives);Audio.validateArchives(archives);Audio.validateArchives(archives,{catalog:PIN});
  const retained=[];let fonts,audio;
  if(dependencyStacks){
    if(Object.keys(dependencyStacks).length!==2||!dependencyStacks.fonts||!dependencyStacks.audio)throw new Error("SDL2_mixer reuse needs exact font and audio profiles.");
    fonts=dependencyStacks.fonts;audio=dependencyStacks.audio;
    retained.push(Prefix.validateStack(fonts,Fonts.PIN,dependencyRecipe("./portable-sdl2-fonts","./portable-sdl2-fonts.json")),Prefix.validateStack(audio,Audio.PIN,dependencyRecipe("./portable-sndfile","./portable-sndfile.json")));
  }
  const recipeSha256=recipeIdentity();fs.mkdirSync(workRoot,{recursive:true});
  if(!fonts){fonts=await Fonts.buildDependencies({archives,workRoot:path.join(workRoot,"fonts"),pathMappings,signal,onProgress,dependencies});audio=await Audio.buildDependencies({archives,workRoot:path.join(workRoot,"audio"),pathMappings,signal,onProgress,dependencies});}
  if(fonts.sdk!==audio.sdk)throw new Error("SDL2_mixer dependencies must use the same macOS SDK.");
  const prefix=path.join(workRoot,"prefix");fs.mkdirSync(prefix);Prefix.linkPrefix(fonts.prefix,prefix);Prefix.linkPrefix(audio.prefix,prefix);
  const descriptor=adaptOpusDescriptor(prefix),sources=[],sourceRoots={},run=dependencies.runBuildCommand||Source.runBuildCommand;
  for(const pin of PIN.dependencies){
    throwIfAborted(signal);const sourceRoot=path.join(workRoot,"source",pin.id);fs.mkdirSync(sourceRoot,{recursive:true});
    await run("/usr/bin/tar",["-xf",archives[pin.id],"--strip-components","1","-C",sourceRoot],{cwd:workRoot,logPath:path.join(workRoot,"extraction.log"),env:Fonts.buildEnvironment(prefix,fonts.sdk),signal});
    for(const notice of pin.notices)if(!fs.lstatSync(path.join(sourceRoot,notice)).isFile())throw new Error(`Missing license for ${pin.name}.`);
    const sourceOverlay=pin.id==="sdl2_mixer"?adaptMixer(sourceRoot):undefined;
    const common={sourceRoot,outputRoot:path.join(workRoot,pin.id),prefix,sdk:fonts.sdk,pathMappings,options:pin.options,signal,dependencies};
    const build=await(pin.buildSystem==="autotools"?Audio.buildAutotools(common):Fonts.buildProject({...common,tools:fonts.tools,onProgress}));
    sourceRoots[pin.id]=sourceRoot;sources.push({...pin,...build,...(sourceOverlay?{sourceOverlay}:{})});
  }
  const features=validateFeatures(workRoot);
  for(const old of retained)if(Prefix.snapshotPrefix(old.prefix).sha256!==old.sha256)throw new Error("A reused dependency prefix changed during compilation.");
  if(recipeIdentity()!==recipeSha256)throw new Error("SDL2_mixer recipe changed during compilation.");
  const readRoots=[fonts.prefix,audio.prefix];
  return {version:PIN.version,architecture:PIN.architecture,minimumMacOS:PIN.minimumMacOS,recipeSha256,prefix,prefixSha256:Prefix.snapshotPrefix(prefix,{readRoots}).sha256,readRoots,sdk:fonts.sdk,tools:fonts.tools,sources,sourceRoots,fonts,audio,descriptor,features,reusedPrefixes:retained.map(({prefix:directory,sha256})=>({prefix:directory,sha256}))};
}

module.exports={PIN,MIXER_CMAKE_SHA256,recipeIdentity,adaptMixer,adaptOpusDescriptor,validateFeatures,buildMixer};
