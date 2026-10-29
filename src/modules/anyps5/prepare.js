const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const GameData = require("../shared/game-data");
const Writable = require("../shared/writable-input");
const Native = require("../shared/runtime/local-native");
const { runToolCommand } = require("../shared/runtime/tool-command");
const { throwIfAborted } = require("../shared/runtime/download-utils");
const { inside, inspectBinary, readBytes, SELF_MAGICS } = require("./detect");

function gameDirectory(entry, context) {
  if (!/^[A-Za-z0-9_-]+$/.test(entry?.gameId || "") || !path.isAbsolute(context?.userDataDir || "")) throw new Error("AnyPS5 requires a game in the library.");
  return GameData.resolveGameModuleDir(context.userDataDir,entry.gameId,"anyps5");
}
const saveDirectory = (entry,context) => entry.saveDirOverride || path.join(gameDirectory(entry,context),"saves");
function resolveProgram(entry) {
  const sourceRoot = fs.realpathSync(entry.contentRootDir || entry.gamePath), executablePath = entry.moduleData?.executablePath;
  if (!path.isAbsolute(executablePath || "") || !inside(sourceRoot,fs.realpathSync(executablePath))) throw new Error("The PS5 program must stay inside the imported game folder.");
  const program = inspectBinary(executablePath);
  if (!program) throw new Error("The PS5 program is missing or invalid.");
  const prepared = entry.moduleData?.inputLayout === "anyps5-prepared";
  const programRoot = fs.realpathSync(prepared ? path.join(sourceRoot, "source") : sourceRoot);
  const assetRoot = fs.realpathSync(prepared ? path.join(sourceRoot, "app0") : sourceRoot);
  if (!inside(sourceRoot, programRoot) || !inside(sourceRoot, assetRoot) || !inside(programRoot, fs.realpathSync(executablePath)))
    throw new Error("The PS5 program and assets must stay inside the imported game folder.");
  return { ...program, executablePath, sourceRoot, programRoot, assetRoot };
}

function isGuestModule(file) {
  if (file.name.endsWith(".guest.prx")) return false;
  const header = readBytes(file.full, 0, 64);
  if (header.length < 20) return false;
  if (SELF_MAGICS.has(header.readUInt32LE(0))) return /\.s?prx$/i.test(file.name) || /^(?:sce_modules?|prx)\//.test(file.name);
  return header.subarray(0,4).equals(Buffer.from([127,69,76,70])) && header[4] === 2 && header[5] === 1 &&
    header.readUInt16LE(18) === 62 && (header.readUInt16LE(16) === 0xfe18 || header.readUInt16LE(16) === 3 && header[7] === 9);
}
function runtimePaths(install) {
  const root = install.payloadRoot || path.dirname(path.dirname(install.executablePath));
  return { root, relinker:install.executablePath, libraries:path.join(root,"libs"), unwrap:path.join(root,"tools","unwrap-self.cjs") };
}
function readRecord(file) {
  try { const stat=fs.lstatSync(file); if(stat.isFile() && !stat.isSymbolicLink() && stat.size < 8*1024*1024) return JSON.parse(fs.readFileSync(file,"utf8")); } catch {}
  return null;
}
async function sourceFiles(sourceRoot,context) {
  const files=[];
  async function walk(directory,relative="",depth=0) {
    if(depth>64) throw new Error("The PS5 game folder is nested too deeply.");
    for(const item of await fs.promises.readdir(directory,{withFileTypes:true})) {
      throwIfAborted(context.signal);
      if([".DS_Store",".git"].includes(item.name)) continue;
      const name=relative?path.join(relative,item.name):item.name, full=path.join(sourceRoot,name);
      if(item.isSymbolicLink()) throw new Error("PS5 game inputs must be ordinary files and folders without aliases.");
      if(item.isDirectory()) await walk(full,name,depth+1);
      else if(item.isFile()) { const stat=await fs.promises.stat(full); files.push({name,full,stamp:`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`}); }
      else throw new Error("PS5 game inputs must be ordinary files and folders.");
      if(files.length>250000) throw new Error("The PS5 game folder has too many files.");
    }
  }
  await walk(sourceRoot);
  return files.sort((a,b)=>a.name.localeCompare(b.name));
}
function assertOutsideSource(source,output) {
  let parent=output;
  while(!fs.existsSync(parent)) parent=path.dirname(parent);
  if(inside(source,path.join(fs.realpathSync(parent),path.relative(parent,output)))) throw new Error("Prepared PS5 files must be stored outside the original game folder.");
}
async function stageAssets(files,app0,previous,context,root) {
  const assets={};let completed=0;
  for(const file of files) {
    throwIfAborted(context.signal);
    const output=path.join(app0,file.name), old=previous?.[file.name];let stat;
    try { stat=fs.lstatSync(output); } catch(error) { if(error.code!=="ENOENT") throw error; }
    if(stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error("Prepared PS5 assets contain an invalid file alias.");
    let sha256=old?.sha256;
    if(!stat || !old || old.stamp!==file.stamp) {
      sha256=Native.hashFile(file.full);
      if(!stat || old && Native.hashFile(output)===old.sha256) Writable.atomicCopy(file.full,output,{root});
    }
    assets[file.name]={stamp:file.stamp,sha256};
    if(++completed%128===0) { context.onProgress?.({phase:"prepare",completed,label:"Preparing game…"});await new Promise(resolve=>setImmediate(resolve)); }
  }
  return assets;
}
function unwrapFile(source,output,install) {
  const header=readBytes(source,0,4);
  if(header?.length===4 && SELF_MAGICS.has(header.readUInt32LE(0))) {
    const helper=require(runtimePaths(install).unwrap);
    if(typeof helper.unwrap!=="function") throw new Error("The AnyPS5 SELF extraction helper is missing.");
    helper.unwrap(source,output);
  } else if(header?.equals(Buffer.from([127,69,76,70]))) Writable.atomicCopy(source,output);
  else return false;
  return true;
}
function bindLibraries(directory,libraries) {
  const output=path.join(directory,"libs");let stat;
  try { stat=fs.lstatSync(output); } catch(error) { if(error.code!=="ENOENT") throw error; }
  if(stat?.isSymbolicLink()) { if(path.resolve(directory,fs.readlinkSync(output))===libraries) return;fs.unlinkSync(output); }
  else if(stat) throw new Error("The private AnyPS5 library path is not a managed runtime alias.");
  fs.symlinkSync(libraries,output,"dir");
}
function bindSaveData(entry,context,directory,sourceRoot,{name="data",suffix=""}={}) {
  const target=path.join(saveDirectory(entry,context),suffix),output=path.join(directory,name);
  if(!path.isAbsolute(target)||/[\0\r\n]/.test(target)) throw new Error("PS5 saves require an absolute local folder.");
  assertOutsideSource(sourceRoot,target);
  let stat;try {stat=fs.lstatSync(output);} catch(error) {if(error.code!=="ENOENT") throw error;}
  if(stat?.isSymbolicLink()) {
    if(path.resolve(directory,fs.readlinkSync(output))===target) {fs.mkdirSync(target,{recursive:true});return;}
    fs.unlinkSync(output);
  } else if(stat) throw new Error("The private PS5 data path is not a managed save alias.");
  fs.mkdirSync(target,{recursive:true});fs.symlinkSync(target,output,"dir");
}
async function prepareGame(entry,context,install,dependencies={}) {
  if(entry.moduleData?.inspectionOnly) throw new Error(entry.moduleData.inspectionReason||"An unpacked PS5 game is required for Play.");
  const program=resolveProgram(entry), root=gameDirectory(entry,context), directory=path.join(root,"launch");
  assertOutsideSource(program.sourceRoot,root);Writable.assertOwnDirectory(context.userDataDir,root);
  Writable.assertOwnDirectory(root,directory);Writable.assertOwnDirectory(root,path.join(directory,"app0"));
  bindSaveData(entry,context,directory,program.sourceRoot);
  bindSaveData(entry,context,directory,program.sourceRoot,{name:"_sd",suffix:"_sd"});
  entry.defaultSaveDir=saveDirectory(entry,context);
  const assetFiles=await sourceFiles(program.assetRoot,context);
  const programFiles=program.programRoot===program.assetRoot?assetFiles:await sourceFiles(program.programRoot,context);
  const modules=programFiles.filter(file=>file.full!==program.executablePath&&isGuestModule(file));
  const compiledNames=new Set(modules.map(file=>file.name+".guest.prx"));
  const files=assetFiles.filter(file=>!compiledNames.has(file.name));
  const recordPath=path.join(root,"preparation.json"), previous=readRecord(recordPath);
  const identity=crypto.createHash("sha256").update(JSON.stringify([2,program.sourceRoot,program.programRoot,program.assetRoot,program.executablePath,install.version,
    install.manifestSha256||install.binarySha256||install.upstreamRevision,files.map(file=>[file.name,file.stamp]),programFiles.map(file=>[file.name,file.stamp])])).digest("hex");
  bindLibraries(directory,runtimePaths(install).libraries);
  if(previous?.schemaVersion===2 && previous.identity===identity && previous.generated?.length && previous.generated.every(file=>{
    try { const output=path.join(directory,file.path),stat=fs.lstatSync(output);return stat.isFile()&&!stat.isSymbolicLink()&&Native.hashFile(output)===file.sha256; } catch { return false; }
  })) return {directory,executable:path.join(directory,"eboot"),cached:true};
  const assets=await stageAssets(files,path.join(directory,"app0"),previous?.source===program.sourceRoot?previous.assets:null,context,root);
  const temporary=fs.mkdtempSync(path.join(root,".convert-")), input=path.join(temporary,"input"), output=path.join(temporary,"output");
  Writable.assertOwnDirectory(root,input);Writable.assertOwnDirectory(root,output);
  try {
    unwrapFile(program.executablePath,path.join(input,"eboot.elf"),install);
    const moduleDirectories=[...new Set(modules.map(file=>path.dirname(file.name)))].sort();
    if(!moduleDirectories.some(name=>["sce_module","sce_modules","prx"].includes(name))) moduleDirectories.push("sce_module");
    for(const name of moduleDirectories) {
      Writable.assertOwnDirectory(root,path.join(input,name));
      for(const file of modules.filter(file=>path.dirname(file.name)===name)) {
        throwIfAborted(context.signal);
        unwrapFile(file.full,path.join(input,file.name),install);
      }
    }
    const logPath=path.join(root,"conversion.log");fs.writeFileSync(logPath,"");
    context.onProgress?.({phase:"prepare",label:"Converting PS5 program…"});
    const moduleArguments=moduleDirectories.filter(name=>!["sce_module","sce_modules","prx"].includes(name)).flatMap(name=>["--module-dir",name]);
    await (dependencies.runCommand||runToolCommand)(runtimePaths(install).relinker,["--macos","--to-rosetta","--registry",...moduleArguments,path.join(input,"eboot.elf"),path.join(output,"eboot")],
      {cwd:temporary,logPath,signal:context.signal,timeout:600000,onSpawn:child=>context.onToolProcessSpawn?.(child)});
    const generated=[];
    async function publish(from,relative="") {
      for(const item of fs.readdirSync(from,{withFileTypes:true})) {
        throwIfAborted(context.signal);
        const name=relative?path.join(relative,item.name):item.name, full=path.join(from,item.name);
        if(item.isDirectory()) await publish(full,name);
        else if(item.isFile()) {
          if(name==="eboot"||name.endsWith(".prx")) {
            if(!Native.readMachOArchitectures(full,{allowLibrary:name!=="eboot"}).includes("x86_64")) throw new Error("The converted PS5 program has an unsupported CPU architecture.");
          }
          Writable.atomicCopy(full,path.join(directory,name),{root});
          generated.push({path:name,sha256:Native.hashFile(full)});
        } else throw new Error("The AnyPS5 conversion contains an invalid output alias.");
      }
    }
    await publish(output);fs.chmodSync(path.join(directory,"eboot"),0o755);
    Writable.atomicWrite(recordPath,JSON.stringify({schemaVersion:2,source:program.sourceRoot,programRoot:program.programRoot,assetRoot:program.assetRoot,identity,assets,generated})+"\n",{root});
    entry.defaultSaveDir=saveDirectory(entry,context);
    return {directory,executable:path.join(directory,"eboot"),cached:false};
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}
module.exports={gameDirectory,saveDirectory,resolveProgram,runtimePaths,prepareGame,unwrapFile,sourceFiles,isGuestModule};
