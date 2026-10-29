const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const Models = require("./models"), Catalog = require("./model-source.json");
const Downloads = require("../../runtime/download-utils"), Writable = require("../../writable-input");
const { runDownloadTask } = require("../../runtime/download-manager");
const { downloadApproved } = require("../../runtime/tool-install");

function sourceFor(version = Catalog.defaultVersion) {
  const source = Catalog.sources.find(row => row.version === version);
  if (!source) throw new Error("Choose an available neural model download.");
  return source;
}
function sourcesFor(method){return Catalog.sources.filter(row=>!method||(row.method||'mlx-dlss')===method);}
function downloadPlan(source){return {managerId:Models.ID,version:source.version,label:source.files?source.label:'Neural rendering model',kind:'tool',requiresDownload:true,confirmLabel:'Download and Continue',downloadBytes:source.bytes,sourceUrl:source.releaseUrl,detail:source.description+' '+source.weightTerms};}
function sourceIdentity(source){return crypto.createHash('sha256').update(JSON.stringify(source.files||[])).digest('hex');}
async function checksum(file, signal) {
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(file, { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW, signal })) hash.update(bytes);
  return hash.digest("hex");
}
function sourceInstalled(rows,source){return rows.find(row => {
    if(row.ready===false)return false;
    if(row.sourceVersion===source.version)return true;
    if(!source.files)return row.weightsHash === source.weightsHash && row.manifestHash === source.manifestHash;
    try{const file=path.join(row.installDir,'download-source.json'),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)return false;const receipt=JSON.parse(fs.readFileSync(file,'utf8'));return receipt.version===source.version&&receipt.inputIdentity===sourceIdentity(source);}catch{return false;}
  });}
async function existingSource(context, source) {
  const installed = sourceInstalled(Models.listInstalled(context.userDataDir),source);
  if (!installed) return null;
  try { return await Models.resolveModel(context.userDataDir, installed.version, { signal: context.signal }); }
  catch (error) {
    Downloads.throwIfAborted(context.signal);if (Downloads.isAbortError(error)) throw error;
    return null;
  }
}
async function downloadModel(context={},dependencies={}){
  const source=dependencies.source||sourceFor(context.sourceVersion);if(!source.files)return downloadDlssMac(context,{...dependencies,source});
  Downloads.throwIfAborted(context.signal);const existing=await existingSource(context,source);if(existing)return existing;
  if(!await downloadApproved(context,downloadPlan(source)))return null;
  return runDownloadTask(context.downloads,{managerId:Models.ID,sectionId:'default',version:source.version,label:source.label,detail:'Downloading model…',kind:'download',dedupeKey:`neural-model:${context.userDataDir}:${source.version}`},async task=>{
    const signal=context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal||undefined,operation={...context,signal};
    return (async()=>{
      Downloads.throwIfAborted(signal);const installed=await existingSource(operation,source);if(installed)return installed;
      const root=path.join(context.userDataDir,'runtimes',Models.ID);Writable.assertOwnDirectory(context.userDataDir,root);
      const temporary=fs.mkdtempSync(path.join(root,'.download-'));let completed=0;
      try{
        for(const row of source.files){
          if(typeof row.file!=='string'||path.basename(row.file)!==row.file||!Number.isSafeInteger(row.bytes)||row.bytes<1||!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error('The model source declaration is invalid.');
          const target=path.join(temporary,row.file),limit=new AbortController(),combined=signal?AbortSignal.any([signal,limit.signal]):limit.signal,downloadBytes=row.downloadBytes||row.bytes;let oversized=false;
          const download=dependencies.downloadToFile||(row.transport==='nvidia-vfx-entry'?((_url,target,options)=>require('./nvidia-vfx-source').downloadEntry(row,target,options)):row.transport==='zip-entry'?((_url,target,options)=>{const archiveCacheDirectory=path.join(root,'.source-archives');Writable.assertOwnDirectory(context.userDataDir,archiveCacheDirectory);return require('./checkpoint-source').downloadEntry(row,target,{...options,archiveCacheDirectory,userDataDir:context.userDataDir});}):row.transport==='bounded-ranges'?((_url,target,options)=>require('./checkpoint-source').downloadFile(row,target,options)):Downloads.downloadToFile);
          try{await download(row.url,target,{signal:combined,onProgress:progress=>{
            if(progress.downloaded>downloadBytes||progress.total>downloadBytes){oversized=true;limit.abort();}
            task.onProgress?.({...progress,downloaded:completed+progress.downloaded,total:source.bytes,label:'Downloading model…'});
          }});}catch(error){if(oversized&&!signal?.aborted)throw new Error('The model asset exceeds its declared size.');throw error;}
          Downloads.throwIfAborted(combined);const stat=fs.lstatSync(target);
          if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.bytes||await checksum(target,combined)!==row.sha256)throw new Error('The model asset does not match its source checksum.');
          completed+=downloadBytes;
        }
        const imported=await Models.importModel({...operation,runtimePath:source.kind==='ncnn-rife'?temporary:path.join(temporary,source.entry),modelIdentifier:source.label,onProgress:progress=>task.onProgress?.({...progress,downloaded:completed,total:source.bytes,detail:progress.label})});
        if(imported.operation!==source.method)throw new Error('The downloaded checkpoint does not match the selected model operation.');
        const receipt=path.join(imported.installDir,'download-source.json');
        if(!fs.existsSync(receipt))fs.writeFileSync(receipt,JSON.stringify({schema:1,version:source.version,inputIdentity:sourceIdentity(source),repository:source.repository,commit:source.commit,sourceLicense:source.sourceLicense,weightTerms:source.weightTerms,files:source.files},null,2)+'\n',{flag:'wx',mode:0o444});
        return imported;
      }finally{fs.rmSync(temporary,{recursive:true,force:true});}
    })();
  },{onProgress:context.onProgress});
}
async function downloadDlssMac(context = {}, dependencies = {}) {
  const source = dependencies.source || sourceFor(context.sourceVersion);
  Downloads.throwIfAborted(context.signal);
  const existing = await existingSource(context, source);
  if (existing) return existing;
  // The setup action passes its own approval; preparation passes the UI adapter.
  if (!await downloadApproved(context, downloadPlan(source))) return null;
  Downloads.throwIfAborted(context.signal);
  return runDownloadTask(context.downloads, { managerId: Models.ID, sectionId: "default", version: source.version,
    label: "Neural rendering model", detail: "Downloading model…", kind: "download",
    dedupeKey: `neural-model:${context.userDataDir}:${source.version}` }, async task => {
    const callerSignal = context.signal && task.signal ? AbortSignal.any([context.signal, task.signal]) : context.signal || task.signal || undefined;
    const operation = { ...context, signal: callerSignal, onProgress: task.onProgress };
    Downloads.throwIfAborted(callerSignal);
    return (async () => {
      Downloads.throwIfAborted(callerSignal);
      const installed = await existingSource(operation, source);
      if (installed) return installed;
      const root = path.join(context.userDataDir, "runtimes", Models.ID);
      Writable.assertOwnDirectory(context.userDataDir, root);
      const temporary = fs.mkdtempSync(path.join(root, ".download-")), archive = path.join(temporary, source.fileName);
      const limit = new AbortController(), signal = callerSignal ? AbortSignal.any([callerSignal, limit.signal]) : limit.signal;
      let oversized = false, reported = 0;
      try {
        await (dependencies.downloadToFile || Downloads.downloadToFile)(source.url, archive, { signal, onProgress: progress => {
          if (progress.downloaded > source.bytes || progress.total > source.bytes) { oversized = true; limit.abort(); }
          const now = Date.now();
          if (now - reported >= 100 || progress.downloaded === source.bytes) {
            reported = now; task.onProgress?.({ ...progress, phase: "download", label: "Downloading neural model…" });
          }
        } });
        Downloads.throwIfAborted(signal);
        task.onProgress?.({downloaded: source.bytes, total: source.bytes, detail: "Verifying neural model…"});
        const stat = fs.lstatSync(archive);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.bytes || await checksum(archive, signal) !== source.sha256)
          throw new Error("The neural model download does not match its release checksum. Try Download again.");
        const imported = await Models.importModel({ ...operation, signal, runtimePath: archive, onProgress: progress =>
          task.onProgress?.({...progress, downloaded: source.bytes, total: source.bytes, detail: progress.label}) });
        if (imported.weightsHash !== source.weightsHash || imported.manifestHash !== source.manifestHash)
          throw new Error("The downloaded release contains a different neural model package.");
        const receipt = path.join(imported.installDir, "download-source.json");
        if (!fs.existsSync(receipt)) fs.writeFileSync(receipt, JSON.stringify({ schema: 1, version: source.version,
          url: source.url, bytes: source.bytes, sha256: source.sha256, commit: source.commit,
          sourceLicense: source.sourceLicense, weightTerms: source.weightTerms }, null, 2) + "\n", { flag: "wx", mode: 0o444 });
        return imported;
      } catch (error) {
        if (oversized && !callerSignal?.aborted) throw new Error("The neural model download exceeds its release size.");
        throw error;
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    })();
  }, { onProgress: context.onProgress });
}
async function ensureNeuralModel(context = {}, dependencies = {}) {
  try {
    Downloads.throwIfAborted(context.signal);
    const method=context.method||'mlx-dlss',installed = Models.listInstalled(context.userDataDir).filter(row=>require('../../effects/neural-selection.mjs').compatibleNeuralModel(row,method));
    const preferences=context.settings?.runtimes?.[Models.ID]||context.settings||{},selected=require('../../effects/neural-selection.mjs').selectNeuralModel(method,installed,{...preferences,defaultVersion:require('../../runtime/custom-runtime').defaultVersion(context.settings,Models.ID)||preferences.defaultVersion});
    const ordered = [...installed.filter(row => row.version === selected?.version), ...installed.filter(row => row.version !== selected?.version)];
    for (const row of ordered) {
      try { const model = await Models.resolveModel(context.userDataDir, row.version, {signal: context.signal});return {modelPath: model.modelPath, version: model.version}; }
      catch (error) { Downloads.throwIfAborted(context.signal);if (Downloads.isAbortError(error)) throw error; }
    }
    const source=dependencies.source||sourcesFor(method).find(row=>row.defaultForOperation)||sourcesFor(method)[0];
    if(!source)throw new Error('Import a compatible model for this operation in Neural models.');
    const result = await downloadModel({...context,sourceVersion:source.version},{...dependencies,source});
    return result ? { modelPath: result.modelPath, version: result.version } : null;
  } catch (error) { if (Downloads.isAbortError(error)) return null; throw error; }
}
module.exports = { sourceFor, sourcesFor, sourceInstalled, downloadPlan, downloadModel, downloadDlssMac, ensureNeuralModel };
