const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Zip = require("../../runtime/zip"), Models = require("./models");
const PICKER_EXTENSIONS=Object.freeze([...Models.PACKAGE_EXTENSIONS,"safetensors","pth","dll","so","app","zip"]);
const LIMITS = {entries: 16384, directory: 16 << 20, packages: 16, notice: 2 << 20, notices: 8 << 20,
  archive: 2 * Models.MAX_WEIGHTS + (32 << 20)};
const noticeName = name => /^(?:LICENSE|NOTICE|COPYING)(?:[._-][A-Za-z0-9._-]+)?$/i.test(name);
const safeName = name => typeof name === "string" && name.length <= 4096 && !/[\\\x00-\x1f]/.test(name) &&
  !name.startsWith("/") && !/^[A-Za-z]:/.test(name) && name.split("/").every(part => part && part !== "." && part !== "..");
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximum) throw new Error("The model source contains an invalid or oversized file.");
  return stat;
}
function children(directory, maximum) {
  const rows = [], opened = fs.opendirSync(directory);
  try { let row;while ((row = opened.readSync())) { if (rows.length >= maximum) throw new Error("The model source contains too many entries.");rows.push(row); } }
  finally { opened.closeSync(); }return rows;
}
function localNotices(directory, maximum) {
  const notices = children(directory, maximum).filter(row => row.isFile() && noticeName(row.name)).map(row => {
    const source = path.join(directory, row.name), stat = regular(source, LIMITS.notice);return {name: row.name, source, bytes: stat.size};
  });
  if (notices.reduce((sum, row) => sum + row.bytes, 0) > LIMITS.notices) throw new Error("The model source notices exceed the size limit.");
  return notices;
}
function appSource(file) {
  const canonical = fs.realpathSync(file), resources = path.join(canonical, "Contents/Resources"), folder = path.join(resources, "models");
  if (!fs.lstatSync(canonical).isDirectory() || fs.realpathSync(folder) !== folder) throw new Error("Choose an application containing compatible model packages.");
  const packages = [];let candidates = 0;
  for (const row of children(folder, 256).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!row.isDirectory() || !Models.packagePattern.test(row.name)) continue;
    if (++candidates > LIMITS.packages) throw new Error("The model source contains too many packages.");
    try { packages.push(Models.inspectPackage(path.join(folder, row.name))); } catch {}
    if (packages.length > LIMITS.packages) throw new Error("The model source contains too many packages.");
  }
  if (!packages.length) throw new Error("This application contains no compatible neural model package.");
  if (packages.reduce((sum, row) => sum + row.weightsStat.size, 0) > Models.MAX_WEIGHTS) throw new Error("The model source exceeds the combined weights size limit.");
  const notices = localNotices(resources, 512);
  return {kind: "application", file: canonical, packages, notices};
}
function archiveSource(file) {
  const stat = regular(file, LIMITS.archive), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);let entries;
  try {
    const info = Zip.findZipEocd(fd);
    if (!info || info.zipBase < 0 || info.cdSize > LIMITS.directory || info.entries > LIMITS.entries ||
        info.zipBase + info.cdOffset + info.cdSize > stat.size) throw new Error("The model ZIP is invalid or too large.");
    entries = Zip.readCentralDirectory(fd, info, {metadata: true});
    if (entries.length !== info.entries) throw new Error("The model ZIP is incomplete.");
  } finally { fs.closeSync(fd); }
  const byName = new Map(), duplicates = new Set();
  for (const entry of entries) {
    if (!safeName(entry.name)) continue;
    const key = entry.name.toLowerCase();if (byName.has(key)) duplicates.add(key);else byName.set(key, entry);
  }
  function selected(name, maximum) {
    const row = byName.get(name.toLowerCase()), type = row?.externalAttributes >>> 16 & 0o170000;
    if (!row || duplicates.has(name.toLowerCase()) || row.flags & 1 || ![0, 8].includes(row.compressionMethod) ||
        ![0, 0o100000].includes(type) || row.uncompressedSize < 1 || row.uncompressedSize > maximum)
      throw new Error("The model ZIP contains an unsafe or oversized model file.");
    return row;
  }
  const packages = [], resources = new Set();let expanded = 0, candidates = 0;
  for (const entry of entries) {
    if (!safeName(entry.name) || entry.name.startsWith("__MACOSX/")) continue;
    const standalone = /^(?:[^/]+\/)?[^/]+\.(?:dlssmodel|vsrmodel|fgmodel|srmodel|restorationmodel|depthmodel)\/manifest\.json$/i.test(entry.name),
      bundled = /^(?:[^/]+\/)?[^/]+\.app\/Contents\/Resources\/models\/[^/]+\.(?:dlssmodel|vsrmodel|fgmodel|srmodel|restorationmodel|depthmodel)\/manifest\.json$/i.test(entry.name);
    if (!standalone && !bundled) continue;
    if (++candidates > LIMITS.packages) throw new Error("The model ZIP contains too many packages.");
    try {
      const manifestEntry = selected(entry.name, Models.MAX_MANIFEST), bytes = Zip.readZipEntry(file, manifestEntry, {maxOutputBytes: Models.MAX_MANIFEST});
      if (!bytes) throw new Error("The model manifest could not be read.");
      const value = Models.inspectManifest(bytes), prefix = entry.name.slice(0, -"manifest.json".length), weightsEntry = selected(prefix + value.weights.file, Models.MAX_WEIGHTS);
      const auxiliary=value.architecture===Models.SR_ARCHITECTURE?[selected(prefix+"postprocess.metal",8<<20)]:value.denoiseWeights?[selected(prefix+value.denoiseWeights.file,Models.MAX_WEIGHTS)]:[];
      packages.push({prefix, bytes, value, manifestEntry, weightsEntry,auxiliary});expanded += manifestEntry.uncompressedSize + weightsEntry.uncompressedSize+auxiliary.reduce((sum,row)=>sum+row.uncompressedSize,0);
      if (bundled) resources.add(prefix.slice(0, prefix.indexOf("/models/") + 1));
      else resources.add(prefix.slice(0, prefix.lastIndexOf("/", prefix.length - 2) + 1));
    } catch (error) {
      // Unsupported packages are not model sources; an explicitly selected
      // compatible package still receives full checksum checks during import.
      continue;
    }
  }
  if (!packages.length) throw new Error("This ZIP contains no compatible neural model package.");
  if (packages.length > LIMITS.packages || expanded > Models.MAX_WEIGHTS + (LIMITS.packages * Models.MAX_MANIFEST))
    throw new Error("The model ZIP exceeds the expanded model size limit.");
  const notices = [];
  for (const entry of entries) {
    const parent = entry.name.slice(0, entry.name.lastIndexOf("/") + 1);
    if (!safeName(entry.name) || !noticeName(path.posix.basename(entry.name)) || !(parent === "" || resources.has(parent))) continue;
    notices.push(selected(entry.name, LIMITS.notice));
  }
  if (notices.reduce((sum, entry) => sum + entry.uncompressedSize, 0) > LIMITS.notices) throw new Error("The model ZIP notices exceed the size limit.");
  return {kind: "archive", file, stat, packages, notices};
}
function inspect(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw new Error("Choose a local neural model source.");
  if(path.basename(file)==='libnvidia-ngx-dlss.so.310.7.0')return inspect(path.dirname(file));
  if(fs.statSync(file).isDirectory()&&fs.existsSync(path.join(file,'libnvidia-ngx-dlss.so.310.7.0')))return {kind:'nvidia-sr-capture',file:fs.realpathSync(file),capture:require('./nvidia-sr-capture').inspect(file),notices:localNotices(file,512)};
  if(fs.statSync(file).isDirectory()&&fs.existsSync(path.join(file,"flownet.param"))&&fs.existsSync(path.join(file,"flownet.bin")))return {kind:"ncnn-rife",file:fs.realpathSync(file),model:require("./ncnn-rife").inspect(file),notices:localNotices(file,512)};
  if(fs.lstatSync(file).isDirectory()&&!fs.lstatSync(file).isSymbolicLink()&&!Models.packagePattern.test(file)&&!/\.app$/i.test(file)){
    const candidates=['nvngx_dlssnr.dll','nvngx_dlssg.dll','libnvidia-ngx-vsr.so.1.8.2'].filter(name=>fs.existsSync(path.join(file,name)));
    if(candidates.length===1)return inspect(path.join(file,candidates[0]));
    if(candidates.length>1)throw new Error('Choose one original model library from this folder.');
  }
  if(/\.dll$/i.test(file)) {
    if(/^nvngx_dlssnr\.dll$/i.test(path.basename(file)))return {kind:'nvidia-nr-weights',file:fs.realpathSync(file),weights:require('./nvidia-nr-weights').inspect(file),notices:localNotices(path.dirname(file),512)};
    let nr;try { nr=require('./nvidia-nr-weights').inspect(file); } catch {}
    if(nr)return {kind:'nvidia-nr-weights',file:fs.realpathSync(file),weights:nr,notices:localNotices(path.dirname(file),512)};
  }
  if(/\.(?:dll|so(?:\.\d+)*)$/i.test(file))return {kind:'nvidia-weights',file:fs.realpathSync(file),weights:require('./nvidia-weight-extractor').inspect(file),notices:localNotices(path.dirname(file),512)};
  if(/\.pth$/i.test(file))return {kind:'torch-weights',file:fs.realpathSync(file),weights:require('./torch-checkpoint').inspect(file),notices:localNotices(path.dirname(file),512)};
  if (Models.packagePattern.test(file)) return {kind: "package", file, packages: [Models.inspectPackage(file)], notices: localNotices(file,512)};
  if(/\.safetensors$/i.test(file)) {
    const weights=require('./weight-adapters').inspect(file),canonical=fs.realpathSync(file);
    let denoiseWeights;
    if(weights.architecture==="realesrgan.srvgg-32.x4.v1"&&!/wdn/i.test(path.basename(file))){
      for(const name of ["realesr-general-wdn-x4v3.safetensors","model-wdn.safetensors"]){
        const companion=path.join(path.dirname(file),name);if(!fs.existsSync(companion))continue;
        const inspected=require('./weight-adapters').inspect(companion);
        if(inspected.architecture!==weights.architecture)throw new Error("The paired WDN weights differ from the general SRVGG graph.");
        denoiseWeights={...inspected,file:fs.realpathSync(companion)};break;
      }
    }
    return {kind:"weights",file:canonical,weights,denoiseWeights,notices:localNotices(path.dirname(file),512)};
  }
  if (/\.app$/i.test(file)) return appSource(file);
  if (/\.zip$/i.test(file)) return archiveSource(file);
  throw new Error("Choose a neural model package, compatible safetensors or Torch weights, model application or ZIP.");
}
function recognizes(file) { try { inspect(file);return true; } catch { return false; } }
async function materialize(source, destination, {signal, onProgress, modelIdentifier} = {}) {
  if(source.kind==='nvidia-sr-capture'){
    const modelPath=path.join(destination,'imported.srmodel');
    await require('./nvidia-sr-capture').convert(source.capture,modelPath,{signal,onProgress});
    return {...source,packages:[{...Models.inspectPackage(modelPath),sourcePackage:'libnvidia-ngx-dlss.so.310.7.0 + exact SR launch capture'}]};
  }
  if(source.kind==='nvidia-nr-weights'){
    const outputs=await require('./nvidia-nr-weights').convert(source.weights,destination,{signal}),packages=[];
    for(const output of outputs){
      const folder=path.join(destination,output.name);fs.mkdirSync(folder);
      const weights=Models.inspectWeights(output.file),topology=require('./nr-models').logicalTopology(weights.tensors),label=output.name==='small'?'Small31':output.name==='ht'?'HT71':`${topology.blocks.length} blocks`;
      const logical=await materialize({kind:'weights',file:output.file,weights,notices:source.notices,provenance:output.sourceFiles},folder,{signal,onProgress,modelIdentifier:`${modelIdentifier||'DLSS neural rendering'} · ${label}`});
      packages.push(...logical.packages);
    }
    return {...source,packages};
  }
  if(source.kind==='nvidia-weights'){
    const file=path.join(destination,'converted.safetensors'),provenance=await require('./nvidia-weight-extractor').convert(source.weights,file,{signal});
    const converted=await materialize({kind:'weights',file,weights:Models.inspectWeights(file),notices:source.notices,provenance:provenance.sourceFiles},destination,{signal,onProgress,modelIdentifier});
    return {...converted,kind:source.kind,file:source.file};
  }
  if(source.kind==='torch-weights'){
    const file=path.join(destination,'converted.safetensors'),provenance=await require('./torch-checkpoint').convert(source.weights,file,{signal,onProgress});
    const converted=await materialize({kind:'weights',file,weights:Models.inspectWeights(file),notices:source.notices,provenance:provenance.sourceFiles},destination,{signal,onProgress,modelIdentifier});
    return {...converted,kind:source.kind,file:source.file};
  }
  if(source.kind==="ncnn-rife"){
    const modelPath=path.join(destination,"imported.fgmodel");fs.mkdirSync(modelPath);
    const weights=require("./ncnn-rife").convert(source.model,path.join(modelPath,"weights.safetensors"),{signal});
    const tensor=name=>({name,dataType:"float32",layout:"nhwc",shape:[1,"height","width",3]});
    fs.writeFileSync(path.join(modelPath,"manifest.json"),JSON.stringify({schemaVersion:1,identifier:modelIdentifier||"rife-v4.6",architecture:source.model.architecture,inputs:[tensor("previous"),tensor("current")],outputs:[tensor("color")],state:{kind:"stateless"},weights:{file:"weights.safetensors",sha256:weights.sha256,tensors:weights.tensors},sourceFiles:weights.sourceFiles}));
    return {...source,packages:[{...Models.inspectPackage(modelPath),sourcePackage:"flownet.param + flownet.bin"}]};
  }
  if(source.kind==="weights") {
    signal?.throwIfAborted();
    const restoration=["realesrgan","nafnet","realcugan"].includes(source.weights.operation),depth=source.weights.operation===require('./depth-models').METHOD,nr=source.weights.operation==='mlx-dlss';
    const extension=nr?'dlssmodel':depth?'depthmodel':restoration?"restorationmodel":source.weights.operation==="mlx-vsr"?"vsrmodel":"fgmodel",modelPath=path.join(destination,"imported."+extension);
    fs.mkdirSync(modelPath);const file="weights.safetensors",target=path.join(modelPath,file);
    const convertedSource=source.weights.adapter?await require('./weight-adapters').convert({...source.weights,file:source.file},target,{signal}):null;
    if(!convertedSource)await fs.promises.copyFile(source.file,target,fs.constants.COPYFILE_FICLONE);
    const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(target,{signal}))hash.update(chunk);
    const tensor=(name,scale=1,channels=3)=>({name,dataType:"float32",layout:"nhwc",shape:scale===1?[1,"height","width",channels]:[1,{symbol:"height",multiplier:scale},{symbol:"width",multiplier:scale},channels]});
    const value={schemaVersion:1,identifier:modelIdentifier||(nr?'org.mlxdlss.external.neural-rendering-transformer':depth?'depth-anything-v2-small':restoration||source.weights.operation==="rife"?source.weights.architecture:source.weights.operation==="mlx-vsr"?"rtx-vsr-1.8.2-highbitrate-low-2x":"mlxdlss-video-frame-generation"),
      architecture:source.weights.architecture,inputs:nr?[tensor('color',1,16)]:depth||restoration||source.weights.operation==="mlx-vsr"?[tensor("color")]:[tensor("previous"),tensor("current")],outputs:[nr?tensor('color',1,4):depth?tensor('relativeInverseDepth',1,1):tensor("color",restoration?require("./restoration-models").ARCHITECTURES[source.weights.architecture].scale:source.weights.operation==='mlx-vsr'?2:1)],
      state:{kind:"stateless",cadence:"frameIndependent",resetPolicy:"explicit"},weights:{file,sha256:hash.digest("hex"),tensors:source.weights.tensors}};
    if(convertedSource)value.sourceFiles=[convertedSource];
    if(source.provenance)value.sourceFiles=source.provenance;
    if(source.denoiseWeights){
      const companion="weights-wdn.safetensors",target=path.join(modelPath,companion),converted=source.denoiseWeights.adapter?await require('./weight-adapters').convert(source.denoiseWeights,target,{signal}):null;
      if(!converted)await fs.promises.copyFile(source.denoiseWeights.file,target,fs.constants.COPYFILE_FICLONE);
      if(converted)value.sourceFiles=[...(value.sourceFiles||[]),converted];
      const hash=crypto.createHash("sha256");for await(const chunk of fs.createReadStream(target,{signal}))hash.update(chunk);
      value.denoiseWeights={file:companion,sha256:hash.digest("hex"),tensors:source.denoiseWeights.tensors};
      const after=fs.lstatSync(source.denoiseWeights.file);if(["dev","ino","size","mtimeMs","ctimeMs"].some(key=>source.denoiseWeights.stat[key]!==after[key]))throw new Error("The selected WDN weights changed during import.");
    }
    fs.writeFileSync(path.join(modelPath,"manifest.json"),JSON.stringify(value,null,2)+"\n");
    const after=fs.lstatSync(source.file);if(["dev","ino","size","mtimeMs","ctimeMs"].some(key=>source.weights.stat[key]!==after[key]))throw new Error("The selected weights changed during import.");
    return {...source,packages:[Models.inspectPackage(modelPath)]};
  }
  if (source.kind !== "archive") return source;
  const packages = [], notices = [];
  for (const [index, row] of source.packages.entries()) {
    signal?.throwIfAborted();
    const modelPath = path.join(destination, index + (row.value.architecture===Models.SR_ARCHITECTURE?".srmodel":".dlssmodel"));fs.mkdirSync(modelPath);
    await Zip.extractZipEntry(source.file, row.manifestEntry, path.join(modelPath, "manifest.json"), {maxOutputBytes: Models.MAX_MANIFEST, signal});
    let reported = 0;
    await Zip.extractZipEntry(source.file, row.weightsEntry, path.join(modelPath, row.value.weights.file), {maxOutputBytes: Models.MAX_WEIGHTS, signal,
      onProgress: completed => {
        const now = Date.now();if (completed !== row.weightsEntry.uncompressedSize && now - reported < 100) return;
        reported = now;onProgress?.({phase: "extract", completed, total: row.weightsEntry.uncompressedSize, label: "Reading neural model…"});
      }});
    for(const entry of row.auxiliary||[])await Zip.extractZipEntry(source.file,entry,path.join(modelPath,path.posix.basename(entry.name)),{maxOutputBytes:Models.MAX_WEIGHTS,signal});
    packages.push({...Models.inspectPackage(modelPath), sourcePackage: row.prefix.replace(/\/$/, "")});
  }
  for (const [index, row] of source.notices.entries()) {
    signal?.throwIfAborted();const file = path.join(destination, "notice-" + index);
    await Zip.extractZipEntry(source.file, row, file, {maxOutputBytes: LIMITS.notice, signal});
    notices.push({name: path.posix.basename(row.name), source: file});
  }
  const after = fs.lstatSync(source.file);
  if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => source.stat[key] !== after[key])) throw new Error("The model ZIP changed during import.");
  return {...source, packages, notices};
}
module.exports = {LIMITS, PICKER_EXTENSIONS, inspect, recognizes, materialize};
