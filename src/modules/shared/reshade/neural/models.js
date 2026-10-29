const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Writable = require("../../writable-input");
const { withRuntimeMutation, withRuntimeUse } = require("../../../../core/coordinated-runtime-managers");
const localHashes = new Map();
const Restoration=require("./restoration-models"),Depth=require('./depth-models'),NR=require('./nr-models');

const ID = "graphics-neural-models", MAX_MANIFEST = 1024 * 1024, MAX_WEIGHTS = 8 * 1024 ** 3;
const architectures = new Set(["mlxdlss.neural-rendering-transformer.v1", "nrk.neural-rendering-transformer.v1"]);
const VSR_ARCHITECTURE = "mlxdlss.rtx-vsr-1.8.2.mode16.v1", FG_ARCHITECTURE = "mlxdlss.video-frame-generation.v1";
const SR_ARCHITECTURE = "mlxdlss.super-resolution.preset-k.ldr2x.v1";
const SR_POSTPROCESS = "1bd949170193f077f75f9c08f8a4a9a6abf21088efbd7795ad8cd463be3517ae";
const PACKAGE_EXTENSIONS=Object.freeze(["dlssmodel","vsrmodel","fgmodel","srmodel","restorationmodel","depthmodel"]);
const packagePattern = new RegExp("\\.(?:"+PACKAGE_EXTENSIONS.join("|")+")$","i");
function vsrShapes() {
  const result = {};
  const convolution = (name, input, output, size = 3) => { result[name + ".weight"] = [output,input,size,size];result[name + ".bias"] = [output]; };
  const block = (name,input,output) => {convolution(name+".conv0",input,output);convolution(name+".conv1",output,output);convolution(name+".shortcut",input,output,1);};
  [[16,16],[16,32],[32,32],[32,64],[64,64]].forEach(([input,output],i)=>block("encoder"+i,input,output));
  [[64,64],[64,32],[32,32],[32,16]].forEach(([input,output],i)=>{convolution("decoder"+i+".upsample",input,output);block("decoder"+i,output*2,output);});
  convolution("output.conv",16,64);convolution("output.project",64,48,1);return result;
}
const VSR_SHAPES = vsrShapes();
const FG_NAMES = [0,1].flatMap(index => [...Array(index===0?3:2).keys()].map(i=>`block${index}.stem${i}`)
  .concat([...Array(8).keys()].map(i=>`block${index}.res${i}`),[...Array(3).keys()].map(i=>`block${index}.bot0.head${i}`),`block${index}.bot1`)
  .flatMap(name=>[name+".weight",name+".bias"]));
const FG_SHAPES=(()=>{
  const shapes={},add=(name,output,input)=>{shapes[name+".weight"]=[output,input,3,3];shapes[name+".bias"]=[output];};
  [[32,16],[32,32],[64,32]].forEach(([out,input],i)=>add("block0.stem"+i,out,input));
  [[16,18],[32,16]].forEach(([out,input],i)=>add("block1.stem"+i,out,input));
  for(const [block,channels,head] of [[0,64,32],[1,32,16]]){
    for(let i=0;i<8;++i)add(`block${block}.res${i}`,channels,channels);
    for(let i=0;i<3;++i)add(`block${block}.bot0.head${i}`,head,channels);
    add(`block${block}.bot1`,8,head);
  }return shapes;
})();
function operationForArchitecture(architecture) {
  return architecture===Depth.ARCHITECTURE?Depth.METHOD:Restoration.ARCHITECTURES[architecture]?.method|| (architectures.has(architecture)?"mlx-dlss":architecture===VSR_ARCHITECTURE?"mlx-vsr":architecture===SR_ARCHITECTURE?"mlx-sr-image":architecture===FG_ARCHITECTURE?"mlx-interpolation":null);
}
function operationTensors(architecture, values) {
  if (!tensors(values,false)) return false;
  if(architecture===Depth.ARCHITECTURE)return Depth.matches(architecture,values);
  if(Restoration.ARCHITECTURES[architecture])return Restoration.matches(architecture,values);
  const entries = new Map(values.map(row=>[row.name,row]));
  if (architecture===VSR_ARCHITECTURE) return entries.size===Object.keys(VSR_SHAPES).length && Object.entries(VSR_SHAPES).every(([name,shape])=>JSON.stringify(entries.get(name)?.shape)===JSON.stringify(shape));
  // The upstream extractor also retains UNet tensors. Keep those bytes and
  // metadata; the selected interpolation graph validates its consumed tensors.
  if (architecture===FG_ARCHITECTURE) return FG_NAMES.every(name=>JSON.stringify(entries.get(name)?.shape)===JSON.stringify(FG_SHAPES[name]));
  return architectures.has(architecture) && NR.matches(values);
}
const validVersion = value => /^sha256-[a-f0-9]{64}$/.test(value || "");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const versionFor = (manifestHash, weightsHash) => "sha256-" + digest(`MacLauncher .dlssmodel v1\0${manifestHash}\0${weightsHash}`);
function storeRoot(userDataDir) {
  if (!path.isAbsolute(userDataDir || "")) throw new Error("Launcher data directory is unavailable.");
  return path.join(userDataDir, "runtimes", ID);
}
function regular(file, maximum) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximum)
    throw new Error("The neural model package must contain regular manifest and weights files.");
  return stat;
}
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const shapeSymbol = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value);
function dimension(value, symbolic) {
  return positiveInteger(value) || symbolic && (shapeSymbol(value) || value && typeof value === "object" &&
    !Array.isArray(value) && shapeSymbol(value.symbol) && positiveInteger(value.multiplier));
}
function tensors(values, symbolic) {
  if (!Array.isArray(values) || !values.length) return false;
  const names = new Set();
  return values.every(value => {
    if (!value || typeof value.name !== "string" || !value.name || /[\x00-\x1f\x7f]/.test(value.name) || names.has(value.name) ||
        !["float16", "float32"].includes(value.dataType) ||
        symbolic && !["nhwc", "nchw", "nthwc", "vector"].includes(value.layout) ||
        !Array.isArray(value.shape) || !value.shape.length || !value.shape.every(size => dimension(size, symbolic))) return false;
    names.add(value.name);
    return true;
  });
}
function manifest(bytes) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("The neural model manifest is invalid."); }
  if(value?.format==="mlxdlss-sr-v1") {
    if(value.model!=="dlss-sr-310.7.0-k-ldr-2x"||value.postprocessSHA256!==SR_POSTPROCESS)throw new Error("Choose the supported DLSS SR preset-K LDR 2× package.");
    return {...value,identifier:value.model,architecture:SR_ARCHITECTURE,weights:{file:"weights.safetensors",sha256:value.weightsSHA256||null,tensors:[]}};
  }
  const weights = value?.weights, filename = weights?.file;
  if(architectures.has(value?.architecture)&&!NR.contract(value))throw new Error('The neural rendering model must declare its 16-feature input and four-channel output.');
  if(Restoration.ARCHITECTURES[value?.architecture]&&!Restoration.contract(value))throw new Error("The restoration model must declare its actual RGB input and intrinsic output scale.");
  if(value?.architecture===Depth.ARCHITECTURE&&!Depth.contract(value))throw new Error('The depth model must declare RGB input and relative inverse-depth scalar output.');
  const operation = operationForArchitecture(value?.architecture);
  if (value?.schemaVersion !== 1 || typeof value.identifier !== "string" || !value.identifier ||
      value.identifier.length > 512 || /[\x00-\x1f\x7f]/.test(value.identifier) || !operation || operation==="mlx-sr-image" ||
      !tensors(value.inputs, true) || !tensors(value.outputs, true) || !operationTensors(value.architecture, weights?.tensors) ||
      value.state?.kind !== "stateless" || (value.state.cadence ?? "frameIndependent") !== "frameIndependent" ||
      (value.state.resetPolicy ?? "explicit") !== "explicit" ||
      value.state.tensors != null && (!Array.isArray(value.state.tensors) || value.state.tensors.length !== 0))
    throw new Error("Choose a compatible neural rendering, super-resolution, restoration or interpolation model package.");
  if (typeof filename !== "string" || !filename || filename.length > 255 || filename === "manifest.json" ||
      [".", ".."].includes(filename) || path.basename(filename) !== filename || /[\\\x00-\x1f\x7f]/.test(filename) ||
      !/^[a-f0-9]{64}$/.test(weights.sha256 || ""))
    throw new Error("The neural model manifest has an invalid weights filename or checksum.");
  if(value.denoiseWeights&&(value.architecture!=="realesrgan.srvgg-32.x4.v1"||typeof value.denoiseWeights.file!=="string"||path.basename(value.denoiseWeights.file)!==value.denoiseWeights.file||/[\\\x00-\x1f]/.test(value.denoiseWeights.file)||value.denoiseWeights.file===filename||!/^[a-f0-9]{64}$/.test(value.denoiseWeights.sha256||"")))throw new Error("The paired WDN model declaration is invalid.");
  return value;
}
// Metadata-only inspection: status and path selection never read/hash weights.
// Full checksum and tensor-content validation occurs on import and native load.
function inspectPackage(runtimePath) {
  if (typeof runtimePath !== "string" || !path.isAbsolute(runtimePath) || /[\0\r\n]/.test(runtimePath) || !packagePattern.test(runtimePath))
    throw new Error("Choose a local neural model package.");
  const directoryStat = fs.lstatSync(runtimePath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("Choose a local neural model package directory.");
  const canonical = fs.realpathSync(runtimePath), manifestPath = path.join(canonical, "manifest.json");
  const manifestStat = regular(manifestPath, MAX_MANIFEST), bytes = fs.readFileSync(manifestPath);
  let raw;try {raw=JSON.parse(bytes);} catch {throw new Error("The neural model manifest is invalid.");}
  let value, auxiliary=[];
  if(raw.format==="mlxdlss-sr-v1") {
    if(raw.model!=="dlss-sr-310.7.0-k-ldr-2x"||raw.postprocessSHA256!==SR_POSTPROCESS)throw new Error("Choose the supported DLSS SR preset-K LDR 2× package.");
    const shaderPath=path.join(canonical,"postprocess.metal"),stat=regular(shaderPath,8<<20);
    if(digest(fs.readFileSync(shaderPath))!==SR_POSTPROCESS)throw new Error("The DLSS SR reconstruction shader changed.");
    const header=inspectWeights(path.join(canonical,"weights.safetensors"),{identify:false});
    value={...raw,identifier:raw.model,architecture:SR_ARCHITECTURE,weights:{file:"weights.safetensors",sha256:raw.weightsSHA256||null,tensors:header.tensors}};
    auxiliary=[{file:"postprocess.metal",source:shaderPath,stat,sha256:SR_POSTPROCESS}];
  } else value=manifest(bytes);
  if(value.architecture===Depth.ARCHITECTURE){const header=inspectWeights(path.join(canonical,value.weights.file),{identify:false});if(!Depth.matches(value.architecture,header.tensors))throw new Error('The depth tensor contents do not match the declared graph.');}
  if(Restoration.ARCHITECTURES[value.architecture]) {
    const header=inspectWeights(path.join(canonical,value.weights.file),{identify:false});
    if(!Restoration.matches(value.architecture,header.tensors))throw new Error("The restoration tensor contents do not match the declared graph.");
    if(value.denoiseWeights) {
      const row=value.denoiseWeights;
      if(value.architecture!=="realesrgan.srvgg-32.x4.v1"||typeof row.file!=="string"||row.file===value.weights.file||path.basename(row.file)!==row.file||/[\\\x00-\x1f]/.test(row.file)||!/^[a-f0-9]{64}$/.test(row.sha256||""))throw new Error("WDN blending requires a separate paired general SRVGG-32 checkpoint.");
      const file=path.join(canonical,row.file),stat=regular(file,MAX_WEIGHTS),weak=inspectWeights(file,{identify:false});
      if(!Restoration.matches(value.architecture,weak.tensors))throw new Error("The paired WDN tensor contents do not match the general graph.");
      auxiliary.push({file:row.file,source:file,stat,sha256:row.sha256});
    }
  }
  const weightsPath = path.join(canonical, value.weights.file), weightsStat = regular(weightsPath, MAX_WEIGHTS);
  return { canonical, directoryStat, manifestPath, manifestStat, bytes, value, weightsPath, weightsStat, auxiliary,
    operation:operationForArchitecture(value.architecture) };
}
function inspectWeights(file,{identify=true}={}) {
  const stat=regular(file,MAX_WEIGHTS),fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const length=Buffer.alloc(8);if(fs.readSync(fd,length,0,8,0)!==8)throw new Error("The neural weights header is incomplete.");
    const size=Number(length.readBigUInt64LE());if(!Number.isSafeInteger(size)||size<2||size>MAX_MANIFEST||size+8>stat.size)throw new Error("The neural weights header is invalid.");
    const data=Buffer.alloc(size);if(fs.readSync(fd,data,0,size,8)!==size)throw new Error("The neural weights header is incomplete.");
    const header=JSON.parse(data),values=Object.entries(header).filter(([name])=>name!=="__metadata__").map(([name,row])=>{
      if(!["F16","F32"].includes(row?.dtype)||!Array.isArray(row.shape)||!row.shape.every(positiveInteger)||!Array.isArray(row.data_offsets)||row.data_offsets.length!==2||!row.data_offsets.every(Number.isSafeInteger)||row.data_offsets[0]<0||row.data_offsets[1]>stat.size-size-8||row.data_offsets[1]<=row.data_offsets[0])throw new Error("The model contains an unsupported tensor.");
      const bytes=row.shape.reduce((total,n)=>total*n, row.dtype==="F16"?2:4);if(bytes!==row.data_offsets[1]-row.data_offsets[0])throw new Error("The neural tensor size is invalid.");
      return {name,dataType:row.dtype==="F16"?"float16":"float32",shape:row.shape};
    });
    const architecture=[...architectures,VSR_ARCHITECTURE,FG_ARCHITECTURE,Depth.ARCHITECTURE,...Object.keys(Restoration.ARCHITECTURES)].find(candidate=>operationTensors(candidate,values));
    if(identify&&!architecture)throw new Error("Choose compatible neural weights or a complete neural model package.");
    return {file,stat,tensors:values,architecture,operation:operationForArchitecture(architecture),metadata:header.__metadata__||{}};
  } finally {fs.closeSync(fd);}
}
async function hashFile(file, signal, onProgress) {
  const hash = crypto.createHash("sha256"); let completed = 0, reported = 0, reportedBytes = -1;
  for await (const bytes of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, signal })) {
    hash.update(bytes); completed += bytes.length;
    const now = Date.now();if (onProgress && now - reported >= 100) { reported = now;reportedBytes = completed;onProgress(completed); }
  }
  if (onProgress && reportedBytes !== completed) onProgress(completed);
  return hash.digest("hex");
}
// Weights checked by resolveModel, keyed by file identity: a rewrite, replacement
// or touch changes the stamp and hashes the file again.
const verifiedHashes = new Map();
const fileStamp = file => {const stat = fs.lstatSync(file, {bigint: true});return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");};
async function stampedHash(file, signal) {
  const stamp = fileStamp(file), cached = verifiedHashes.get(file);
  if (cached?.stamp === stamp) return cached.hash;
  const hash = await hashFile(file, signal);
  verifiedHashes.delete(file);
  // A file that changed while it was read is hashed again next time.
  if (fileStamp(file) === stamp) {
    if (verifiedHashes.size >= 64) verifiedHashes.delete(verifiedHashes.keys().next().value);
    verifiedHashes.set(file, {stamp, hash});
  }
  return hash;
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function sourceMetadata(directory,manifest){
  const sources=require('./model-source.json').sources;let source;
  try{const file=path.join(directory,'download-source.json');regular(file,65536);const receipt=JSON.parse(fs.readFileSync(file,'utf8')),row=sources.find(row=>row.version===receipt.version);
    if(row&&(row.files?receipt.inputIdentity===digest(JSON.stringify(row.files)):receipt.sha256===row.sha256))source=row;
  }catch{}
  if(!source)try{
    const provenance=new Set([...(manifest.sourceFiles||[]).filter(row=>/^[a-f0-9]{64}$/.test(row?.sha256||'')).map(row=>row.sha256),manifest.weights?.sha256,manifest.denoiseWeights?.sha256]),notices=fs.readdirSync(path.join(directory,'notices'));
    source=sources.find(row=>(row.method||'mlx-dlss')===operationForArchitecture(manifest.architecture)&&row.files&&row.files.filter(asset=>!/^(LICENSE|NOTICE|COPYING)/i.test(asset.file)).every(asset=>provenance.has(asset.sha256))&&row.files.filter(asset=>/^(LICENSE|NOTICE|COPYING)/i.test(asset.file)).every(asset=>notices.some(name=>{if(!name.endsWith('-'+asset.file))return false;const stat=fs.lstatSync(path.join(directory,'notices',name));return stat.isFile()&&!stat.isSymbolicLink()&&stat.size===asset.bytes;})));
  }catch{}
  return source?{sourceVersion:source.version,...(source.defaultForOperation===true?{curatedDefault:true}:{})}:{};
}
function readInstall(userDataDir, selected) {
  try {
    if (!validVersion(selected)) return null;
    const root = storeRoot(userDataDir), installDir = path.join(root, selected);
    const receiptFile = path.join(installDir, "model.json"); regular(receiptFile, 64 * 1024);
    const record = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
    if(record.packageName!=null&&!["model.dlssmodel","model.vsrmodel","model.fgmodel","model.srmodel","model.restorationmodel","model.depthmodel"].includes(record.packageName))return null;
    const modelPath=path.join(installDir,record.packageName||"model.dlssmodel");
    Writable.assertOwnDirectory(userDataDir, modelPath, { create: false });
    if (record.schema !== 1 || record.version !== selected || !/^[a-f0-9]{64}$/.test(record.manifestHash || "") ||
        !/^[a-f0-9]{64}$/.test(record.weightsHash || "") || versionFor(record.manifestHash, record.weightsHash) !== selected ||
        !Number.isSafeInteger(record.weightsBytes) || record.weightsBytes < 1 || record.weightsBytes > MAX_WEIGHTS) return null;
    const package_ = inspectPackage(modelPath);
    if (digest(package_.bytes) !== record.manifestHash || package_.value.weights.sha256 && package_.value.weights.sha256 !== record.weightsHash ||
        package_.weightsStat.size !== record.weightsBytes) return null;
    return { version: selected, versionLabel: `${package_.value.identifier} · ${selected.slice(7, 15)}`,...sourceMetadata(installDir,package_.value),
      identifier: package_.value.identifier, architecture: package_.value.architecture,operation:package_.operation,method:package_.operation,
      intrinsicScale:Restoration.ARCHITECTURES[package_.value.architecture]?.scale||(["mlx-vsr","mlx-sr-image"].includes(package_.operation)?2:1),
      pairedDenoiser:Boolean(package_.value.denoiseWeights),
      compatibleMethods:package_.operation==="mlx-sr-image"?["mlx-sr-image","mlx-sr-scene"]:[package_.operation],
      installDir, modelPath, weightsPath: package_.weightsPath, weightsBytes: record.weightsBytes,
      manifestHash: record.manifestHash, weightsHash: record.weightsHash, importedAt: record.importedAt,
      ready: true, imported: true, removable: true };
  } catch { return null; }
}
function listCopies(userDataDir, management) {
  try {
    const root = storeRoot(userDataDir); Writable.assertOwnDirectory(userDataDir, root, { create: false });
    return fs.readdirSync(root).filter(validVersion).map(version => {
      const installed = readInstall(userDataDir, version);
      if (installed || !management) return installed;
      const installDir = path.join(root, version);
      try {
        Writable.assertOwnDirectory(userDataDir, installDir, {create: false});
        const stat = fs.lstatSync(installDir);if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        return {version, versionLabel: `Neural model · ${version.slice(7, 15)}`, installDir,
          ready: false, imported: true, removable: true,
          error: "The imported model is incomplete or changed. Import the original package again, or remove this copy."};
      } catch { return null; }
    }).filter(Boolean)
      .sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)) || a.version.localeCompare(b.version));
  } catch { return []; }
}
function listInstalled(userDataDir) { return listCopies(userDataDir, false); }
function listManaged(userDataDir) { return listCopies(userDataDir, true); }
async function resolveModel(userDataDir, selected, { signal } = {}) {
  const installed = readInstall(userDataDir, selected);
  if (!installed || await stampedHash(installed.weightsPath, signal) !== installed.weightsHash)
    throw new Error("The imported neural model changed. Import the original package again in Graphics → Neural models.");
  const source=inspectPackage(installed.modelPath);
  for(const row of source.auxiliary)if(await stampedHash(row.source,signal)!==row.sha256)throw new Error("The imported model companion changed.");
  return installed;
}
function inspectCustom(runtimePath, { verification = "full" } = {}) {
  const source = inspectPackage(runtimePath), stat = source.weightsStat;
  const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":"), cached = localHashes.get(source.weightsPath);
  const verified = cached?.stamp === stamp;
  const weightsHash = verified ? cached.hash : verification === "status" ? source.value.weights.sha256 || null
    : require("../../runtime/local-native").hashFile(source.weightsPath);
  if (source.value.weights.sha256 && weightsHash !== source.value.weights.sha256) throw new Error("The neural model weights differ from their manifest checksum.");
  if (verified || verification !== "status") {
    if (localHashes.size >= 64) localHashes.delete(localHashes.keys().next().value);
    localHashes.set(source.weightsPath, { stamp, hash: weightsHash });
  }
  return { installDir: source.canonical, modelPath: source.canonical, weightsPath: source.weightsPath, weightsBytes: stat.size,
    manifestHash: digest(source.bytes), weightsHash, identifier: source.value.identifier, versionLabel: source.value.identifier,
    architecture: source.value.architecture, operation: source.operation, method: source.operation,
    intrinsicScale: Restoration.ARCHITECTURES[source.value.architecture]?.scale||(["mlx-vsr", "mlx-sr-image"].includes(source.operation)?2:1),
    pairedDenoiser:Boolean(source.value.denoiseWeights),
    compatibleMethods: source.operation === "mlx-sr-image" ? ["mlx-sr-image", "mlx-sr-scene"] : [source.operation], ready: true };
}
function identityForPath(userDataDir, modelPath) {
  if (typeof modelPath !== "string" || !path.isAbsolute(modelPath)) return null;
  const selected = module.exports.listInstalled(userDataDir).find(item => item.modelPath === modelPath);
  return selected ? { managerId: ID, sectionId: "default", version: selected.version, sourcePath: selected.installDir } : null;
}
async function importModel(context = {}) {
  const {userDataDir, runtimePath, signal} = context, Sources = require("./model-sources");
  signal?.throwIfAborted();
  const selected = Sources.inspect(runtimePath);
  const root = storeRoot(userDataDir); Writable.assertOwnDirectory(userDataDir, root);
  const expanded = ["archive","weights","ncnn-rife","nvidia-weights","nvidia-nr-weights","torch-weights","nvidia-sr-capture"].includes(selected.kind) ? fs.mkdtempSync(path.join(root, ".source-")) : null;
  try {
    const source = await Sources.materialize(selected, expanded, context), imported = [];
    for (const model of source.packages) imported.push(await importPackage(context, model, source));
    return imported.length === 1 ? imported[0] : {...imported[0], importedModels: imported.map(row => row.version)};
  } finally { if (expanded) fs.rmSync(expanded, {recursive: true, force: true}); }
}
function preserveSource(directory, source, model, userDataDir) {
  if (source.kind === "package" && !source.notices.length) return;
  const receipt = path.join(directory, "source.json");
  if (fs.existsSync(receipt)) return;
  const notices = path.join(directory, "notices");Writable.assertOwnDirectory(userDataDir, notices);
  for (const [index, row] of source.notices.entries()) {
    regular(row.source, 2 << 20);
    const target = path.join(notices, index + "-" + row.name);
    fs.copyFileSync(row.source, target, fs.constants.COPYFILE_EXCL);fs.chmodSync(target, 0o444);
  }
  fs.writeFileSync(receipt, JSON.stringify({schema: 1, kind: source.kind, fileName: path.basename(source.file),
    packagePath: model.sourcePackage || path.relative(source.file, model.canonical).split(path.sep).join("/")}, null, 2) + "\n", {flag: "wx", mode: 0o444});
}
async function importPackage(context, source, origin) {
  const {userDataDir, signal, onProgress} = context, root = storeRoot(userDataDir);
  signal?.throwIfAborted();
  const packageName=source.operation===Depth.METHOD?'model.depthmodel':source.operation==="mlx-sr-image"?"model.srmodel":source.operation==="mlx-vsr"?"model.vsrmodel":["mlx-interpolation","rife"].includes(source.operation)?"model.fgmodel":Restoration.ARCHITECTURES[source.value.architecture]?"model.restorationmodel":"model.dlssmodel";
  const temporary = fs.mkdtempSync(path.join(root, ".import-")), modelPath = path.join(temporary, packageName);
  fs.mkdirSync(modelPath); let backup, target, published = false;
  try {
    fs.writeFileSync(path.join(modelPath, "manifest.json"), source.bytes, { flag: "wx", mode: 0o444 });
    const weightsPath = path.join(modelPath, source.value.weights.file);
    await fs.promises.copyFile(source.weightsPath, weightsPath, fs.constants.COPYFILE_FICLONE);
    const weightsHash = await hashFile(weightsPath, signal, completed => onProgress?.({ phase: "import", completed,
      total: source.weightsStat.size, label: "Importing neural model…" }));
    if (source.value.weights.sha256 && weightsHash !== source.value.weights.sha256) throw new Error("The neural model weights do not match their manifest checksum.");
    for(const row of source.auxiliary||[]) {
      const target=path.join(modelPath,row.file);await fs.promises.copyFile(row.source,target,fs.constants.COPYFILE_FICLONE);
      if(digest(fs.readFileSync(target))!==row.sha256||!sameFile(row.stat,fs.lstatSync(row.source)))throw new Error("The neural model support file changed during import.");
      fs.chmodSync(target,0o444);
    }
    if (!sameFile(source.manifestStat, fs.lstatSync(source.manifestPath)) || !sameFile(source.weightsStat, fs.lstatSync(source.weightsPath)) ||
        !sameFile(source.directoryStat, fs.lstatSync(source.canonical))) throw new Error("The selected neural model changed during import. Try again.");
    const manifestHash = digest(source.bytes), selected = versionFor(manifestHash, weightsHash);
    target = path.join(root, selected);
    const identity = { managerId: ID, sectionId: "default", version: selected, sourcePath: target };
    const reused = await withRuntimeUse(identity, async () => {
      const previous = readInstall(userDataDir, selected);
      // Adding source notices is a write and belongs to the publication lock.
      const completeSource = origin.kind === "package" && !origin.notices.length || previous && fs.existsSync(path.join(previous.installDir, "source.json"));
      return previous && completeSource && await hashFile(previous.weightsPath, signal) === weightsHash ? previous : null;
    }, { userDataDir });
    if (reused) return reused;
    return await withRuntimeMutation(identity, async () => {
      try {
        const previous = readInstall(userDataDir, selected);
        if (previous && await hashFile(previous.weightsPath, signal) === weightsHash) {
          preserveSource(previous.installDir, origin, source, userDataDir);return previous;
        }
        signal?.throwIfAborted();
        fs.chmodSync(weightsPath, 0o444);
        fs.writeFileSync(path.join(temporary, "model.json"), JSON.stringify({ schema: 1, version: selected, manifestHash,
          weightsHash, weightsBytes: source.weightsStat.size, packageName, importedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o444 });
        preserveSource(temporary, origin, source, userDataDir);
        const existing = fs.lstatSync(target, { throwIfNoEntry: false });
        if (existing) {
          if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("The model installation is not a regular directory.");
          backup = target + ".previous-" + crypto.randomUUID(); fs.renameSync(target, backup);
        }
        fs.renameSync(temporary, target);
        published = true;
        const result = readInstall(userDataDir, selected);
        if (!result) throw new Error("The imported neural model could not be verified.");
        if (backup) fs.rmSync(backup, { recursive: true, force: true });
        context.onRuntimeStateChange?.(); return result;
      } catch (error) {
        if (backup) { fs.rmSync(target, { recursive: true, force: true }); fs.renameSync(backup, target); }
        else if (published) fs.rmSync(target, { recursive: true, force: true });
        throw error;
      }
    }, { userDataDir });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
async function removeModel({ userDataDir, version, installDir } = {}) {
  if (!validVersion(version)) throw new Error("Choose an imported neural model.");
  const target = path.join(storeRoot(userDataDir), version);
  if (installDir && path.resolve(installDir) !== target) throw new Error("The directory does not belong to this imported model.");
  Writable.assertOwnDirectory(userDataDir, target, { create: false });
  return withRuntimeMutation({ managerId: ID, sectionId: "default", version, sourcePath: target }, () => {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false }); if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The model installation is not a regular directory.");
    fs.rmSync(target, { recursive: true }); return true;
  }, { userDataDir });
}
module.exports = { ID, MAX_MANIFEST, MAX_WEIGHTS, validVersion, inspectManifest: manifest, inspectPackage, inspectWeights,
  packagePattern,PACKAGE_EXTENSIONS,operationForArchitecture,VSR_ARCHITECTURE,FG_ARCHITECTURE,SR_ARCHITECTURE,
  listInstalled, listManaged, importModel, resolveModel, removeModel, identityForPath, inspectCustom };
