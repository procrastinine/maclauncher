const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {spawn} = require('node:child_process'), {once} = require('node:events');
const Writable = require('../shared/writable-input');
const {confirmToolInstall} = require('../shared/runtime/tool-install');
const {downloadToFile, createAbortError} = require('../shared/runtime/download-utils');
const {runDownloadTask} = require('../shared/runtime/download-manager');
const {environment} = require('../shared/runtime/macos-sandbox');
const {acquireCatalogLock} = require('./catalog-lock');
const verified = new Map(), SHA = /^[a-f0-9]{64}$/;
const identity = stat => [stat.dev,stat.ino,stat.size,stat.mode,stat.mtimeNs,stat.ctimeNs].join(':');

async function command(file, args, {context={}, signal=context.signal, input, timeout=120000}={}) {
  signal?.throwIfAborted();
  const child = spawn(file,args,{env:{...environment(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin'},stdio:['pipe','pipe','pipe']});
  const output=[], errors=[];let bytes=0,failure,force;
  const stop = error => {failure ||= error;child.kill('SIGTERM');force ||= setTimeout(()=>child.kill('SIGKILL'),2000);};
  const collect = (target,data) => {bytes+=data.length;if(bytes>4*1024*1024)stop(Error('Android image command output exceeded its limit.'));else target.push(data);};
  child.stdout.on('data',data=>collect(output,data));child.stderr.on('data',data=>collect(errors,data));child.stdin.on('error',()=>{});child.stdin.end(input);
  const abort=()=>stop(signal.reason||createAbortError());signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(()=>stop(Error('Android image command timed out.')),timeout);
  const ownership=Promise.resolve().then(()=>context.onToolProcessSpawn?.(child,{stopOnLauncherExit:true})).catch(error=>stop(error));
  try {const [code,reason]=await once(child,'close');await ownership;if(failure)throw failure;if(code!==0)throw Error(Buffer.concat(errors).toString().trim()||`Android image command failed (${reason||code}).`);return Buffer.concat(output).toString();}
  finally {clearTimeout(timer);clearTimeout(force);signal?.removeEventListener('abort',abort);}
}
async function regular(file, maximum=Infinity) {
  const stat=await fs.promises.lstat(file,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==BigInt(process.getuid())||stat.size>maximum)throw Error('Android image storage must contain owned regular files.');
  return stat;
}
async function hashFile(file,signal) {
  const before=await regular(file),hash=crypto.createHash('sha256');
  const handle=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {for await(const bytes of handle.createReadStream({autoClose:false})){signal?.throwIfAborted();hash.update(bytes);}
    if(identity(before)!==identity(await handle.stat({bigint:true}))||identity(before)!==identity(await regular(file)))throw Error('Android image changed during verification.');
    return hash.digest('hex');
  }finally{await handle.close();}
}

// Matches the producer's complete imageContentIdentity: modes, link text and
// regular-file bytes, without following original Android symlinks.
async function contentIdentity(root,signal) {
  const hash=crypto.createHash('sha256');let records=0,bytes=0;
  async function visit(relative){
    signal?.throwIfAborted();const file=path.join(root,relative),stat=await fs.promises.lstat(file),name=relative.split(path.sep).join('/'),mode=stat.mode&0o7777;let row;
    if(stat.isSymbolicLink())row=[name,'link',mode,await fs.promises.readlink(file)];
    else if(stat.isDirectory())row=[name,'directory',mode];
    else if(stat.isFile()){
      const content=crypto.createHash('sha256'),handle=await fs.promises.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{for await(const chunk of handle.createReadStream({autoClose:false})){signal?.throwIfAborted();content.update(chunk);}
        const after=await handle.stat();if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==after.size||stat.mtimeMs!==after.mtimeMs||stat.ctimeMs!==after.ctimeMs)throw Error('Android image changed during verification.');
      }finally{await handle.close();}
      bytes+=stat.size;row=[name,'file',mode,stat.size,content.digest('hex')];
    }else throw Error('Android image contains an unsupported file type.');
    if(++records>200000||bytes>32*1024**3)throw Error('Android image exceeds its supported size.');
    hash.update(JSON.stringify(row)+'\n');
    if(stat.isDirectory())for(const child of (await fs.promises.readdir(file)).sort())await visit(path.join(relative,child));
  }
  await visit('');return {sha256:hash.digest('hex'),records,bytes};
}
const sameContent=(actual,wanted)=>['sha256','records','bytes'].every(key=>actual[key]===wanted[key]);
const exists=file=>{try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
function validate(image,expected){
  if(!SHA.test(image?.sha256||'')||!/^https:\/\//.test(image.url||'')||!Number.isSafeInteger(image.bytes||image.size)||!(image.bytes||image.size)||
    !SHA.test(expected?.sha256||'')||!Number.isSafeInteger(expected.records)||expected.records<1||!Number.isSafeInteger(expected.bytes)||expected.bytes<1)
    throw Error('The Android system image identity is incomplete.');
}

async function attachments(run,context){
  const raw=await run('/usr/bin/hdiutil',['info','-plist'],{context});
  const json=await run('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{context,input:raw});
  const images=JSON.parse(json).images;if(!Array.isArray(images))throw Error('Android image attachment information is invalid.');return images;
}
async function attach(base,mount,run,context){
  const images=await attachments(run,context);
  for(const image of images){const mounts=(image['system-entities']||[]).map(row=>row['mount-point']).filter(Boolean);
    if(!mounts.includes(mount))continue;
    if(image['image-path']!==base||image.writeable!==false||image['shadow-path'])throw Error('The Android image mount belongs to a different or writable image.');
    return;
  }
  Writable.assertOwnDirectory(path.dirname(mount),mount);
  await run('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,base],{context});
  const attached=await attachments(run,context);
  if(!attached.some(image=>image['image-path']===base&&image.writeable===false&&!image['shadow-path']&&
    image['system-entities']?.some(row=>row['mount-point']===mount)))throw Error('The Android image did not attach read-only at its private mount.');
}
async function lock(file,signal,acquire){
  for(;;){signal?.throwIfAborted();const release=await acquire(file,{wait:false});if(release)return release;
    await new Promise((resolve,reject)=>{const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve();},abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal.reason||createAbortError());};const timer=setTimeout(done,100);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
  }
}
function legacyLocations(userDataDir){
  const parent=path.join(userDataDir,'android/runtimes/aim');Writable.assertOwnDirectory(userDataDir,parent,{create:false});
  const versions=new Set(require('./providers/aim/image-cache.json').legacy.flatMap(row=>row.versions));
  const images=path.join(parent,'images');
  if(exists(images)){Writable.assertOwnDirectory(parent,images,{create:false});for(const name of fs.readdirSync(images).filter(name=>SHA.test(name)).slice(0,64))versions.add('images/'+name);}
  return [...versions].map(name=>path.join(parent,name));
}

async function legacyBase({context,image,expected,run,compute,locations}){
  let attached;
  for(const candidate of locations(context.userDataDir)){
    Writable.assertOwnDirectory(context.userDataDir,candidate,{create:false});
    const source=path.join(candidate,'system.dmg'),original=path.join(candidate,'system/root'),id=path.join(candidate,'system/root.identity');
    if(!exists(source)||!exists(id)||!exists(original))continue;
    Writable.assertOwnDirectory(candidate,path.dirname(id),{create:false});
    const before=await regular(source);await regular(id,1024);
    if(fs.readFileSync(id,'utf8').trim()!==image.sha256)continue;
    attached ||= await attachments(run,context);
    if(!attached.some(row=>row['image-path']===source&&row.writeable===false&&!row['shadow-path']&&row['system-entities']?.some(item=>item['mount-point']===path.join(candidate,'system'))))continue;
    if(!sameContent(await compute(original,context.signal),expected))continue;
    if(identity(before)!==identity(await regular(source)))throw Error('The original Android image changed during verification.');
    return {source,identity:identity(before)};
  }
  return null;
}

/** One original immutable image per archive identity. The owned ART/AIM
 * adaptation and writable application data remain separate from this base. */
async function prepare({context,image,expected,extractor,existingOnly=false},dependencies={}){
  validate(image,expected);context.signal?.throwIfAborted();
  const userDataDir=path.resolve(context.userDataDir||'');if(!path.isAbsolute(context.userDataDir||''))throw Error('Android data storage is unavailable.');
  const parent=path.join(userDataDir,'android/system-images'),directory=path.join(parent,image.sha256),base=path.join(directory,'system.dmg'),mount=path.join(directory,'mounted');
  Writable.assertOwnDirectory(userDataDir,directory,{create:false});
  if(existingOnly&&!exists(base))return null;
  const run=dependencies.command||command,hash=dependencies.hashFile||hashFile,compute=dependencies.contentIdentity||contentIdentity;
  // Existing, already acquired originals need verification but no download
  // prompt. A declined new acquisition still creates no cache directories.
  const candidate=exists(base)?null:await legacyBase({context,image,expected,run,compute,locations:dependencies.legacyLocations||legacyLocations});
  if(!exists(base)&&!candidate)await (dependencies.confirm||confirmToolInstall)(context,{managerId:'android-system-image',version:image.sha256,label:'Android system image',requiresDownload:true,
    detail:'Download the Android 16 system image under the Android SDK license: '+(image.licenseUrl||'https://developer.android.com/studio/terms')});
  context.signal?.throwIfAborted();Writable.assertOwnDirectory(userDataDir,parent);
  const release=await lock(path.join(parent,'.'+image.sha256+'.lock'),context.signal,dependencies.acquireLock||acquireCatalogLock);
  let staging,published=false;const stagingMounts=new Set();
  const acquire=async({signal:taskSignal,onProgress}={})=>{
  const signal=context.signal&&taskSignal?AbortSignal.any([context.signal,taskSignal]):context.signal||taskSignal;
  context={...context,signal};
  try{
    Writable.assertOwnDirectory(userDataDir,directory,{create:false});
    if(existingOnly&&!exists(base))return null;
    if(!exists(base)){
      staging=await fs.promises.mkdtemp(path.join(parent,'.image-'));
      const reused=Boolean(candidate);
      if(candidate){
        const source=candidate.source;
        if(identity(await regular(source))!==candidate.identity)throw Error('The original Android image changed during preparation.');
        const destination=path.join(staging,'system.dmg');
        // Separate inodes preserve each image owner's attach/detach lifecycle;
        // APFS clones still share the immutable physical extents.
        await fs.promises.copyFile(source,destination,fs.constants.COPYFILE_FICLONE|fs.constants.COPYFILE_EXCL);
        if(identity(await regular(source))!==candidate.identity)throw Error('The original Android image changed during preparation.');
      }
      if(!reused){
        const archive=path.join(staging,'system.zip');
        await (dependencies.downloadToFile||downloadToFile)(image.url,archive,{signal,onProgress});
        onProgress?.({detail:'Verifying…'});
        const stat=await regular(archive);if(Number(stat.size)!==(image.bytes||image.size)||await hash(archive,signal)!==image.sha256)throw Error('The Android system image checksum did not match.');
        context.signal?.throwIfAborted();
        onProgress?.({detail:'Preparing…'});
        const sparse=path.join(staging,'build.sparseimage'),building=path.join(staging,'build');
        await run('/usr/bin/hdiutil',['create','-size','16g','-type','SPARSE','-fs','Case-sensitive APFS','-volname','Android System','-o',sparse],{context,timeout:120000});
        Writable.assertOwnDirectory(staging,building);
        stagingMounts.add(building);await run('/usr/bin/hdiutil',['attach','-readwrite','-nobrowse','-mountpoint',building,sparse],{context});
        await run(extractor,[archive,path.join(building,'root')],{context,timeout:20*60*1000});
        if(fs.readFileSync(path.join(building,'root.identity'),'utf8').trim()!==image.sha256)throw Error('The Android system image archive identity differs from its selected supplier.');
        await run('/usr/bin/hdiutil',['detach',building],{context:{...context,signal:undefined}});stagingMounts.delete(building);
        await run('/usr/bin/hdiutil',['convert',sparse,'-format','UDRO','-o',path.join(staging,'system.dmg')],{context,timeout:20*60*1000});
        await fs.promises.rm(sparse);await fs.promises.rm(archive);
        await fs.promises.rm(building,{recursive:true,force:true});
      }
      const stagedBase=path.join(staging,'system.dmg');await fs.promises.chmod(stagedBase,0o400);
      onProgress?.({detail:'Verifying…'});
      if(!reused){const checkMount=path.join(staging,'verify');
        stagingMounts.add(checkMount);await attach(stagedBase,checkMount,run,context);
        if(fs.readFileSync(path.join(checkMount,'root.identity'),'utf8').trim()!==image.sha256||!sameContent(await compute(path.join(checkMount,'root'),context.signal),expected))
          throw Error('The Android system image content differs from its selected supplier.');
        await run('/usr/bin/hdiutil',['detach',checkMount],{context:{...context,signal:undefined}});stagingMounts.delete(checkMount);
        await fs.promises.rm(checkMount,{recursive:true,force:true});
      }
      const stat=await regular(stagedBase),dmgSha256=await hash(stagedBase,context.signal);
      Writable.atomicWrite(path.join(staging,'image.json'),JSON.stringify({schemaVersion:1,archiveSha256:image.sha256,content:expected,dmgSha256,dmgBytes:Number(stat.size)})+'\n',{root:staging});
      const stable=identity(await regular(stagedBase));
      await fs.promises.rename(staging,directory);staging=null;
      if(identity(await regular(base))!==stable)throw Error('The Android system image changed during publication.');
      published=true;
    }
    const before=await regular(base);if(Number(before.mode)&0o222)throw Error('The Android system image must remain read-only.');
    const receiptFile=path.join(directory,'image.json');await regular(receiptFile,8192);const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
    if(receipt.schemaVersion!==1||receipt.archiveSha256!==image.sha256||!sameContent(receipt.content,expected)||!SHA.test(receipt.dmgSha256||'')||receipt.dmgBytes!==Number(before.size))throw Error('The Android system image receipt differs from its selected supplier.');
    await attach(base,mount,run,context);const root=path.join(mount,'root');
    const key=JSON.stringify([identity(before),receipt.dmgSha256,expected,fs.statSync(root).dev,fs.statSync(root).ino]);
    if(!verified.has(key)){
      // The cache is outside every guest's writable namespace. Retain the
      // original full verification across launcher workers, invalidating it
      // on any inode, content-time, mode or selected-identity change.
      const fingerprint={schemaVersion:1,archiveSha256:image.sha256,content:expected,dmgSha256:receipt.dmgSha256,baseIdentity:identity(before)};
      const verificationFile=path.join(directory,'verified.json');let prior;
      try{const stat=await regular(verificationFile,8192);if((Number(stat.mode)&0o077)===0)prior=JSON.parse(fs.readFileSync(verificationFile,'utf8'));}
      catch(error){if(!['ENOENT'].includes(error.code)&&!(error instanceof SyntaxError))throw error;}
      const persisted=JSON.stringify(prior)===JSON.stringify(fingerprint);
      if(fs.readFileSync(path.join(mount,'root.identity'),'utf8').trim()!==image.sha256||!published&&
        !persisted&&(await hash(base,context.signal)!==receipt.dmgSha256||!sameContent(await compute(root,context.signal),expected)))throw Error('The Android system image content changed.');
      if(!persisted)Writable.atomicWrite(verificationFile,JSON.stringify(fingerprint)+'\n',{root:directory});
      verified.set(key,true);if(verified.size>8)verified.delete(verified.keys().next().value);
    }
    context.signal?.throwIfAborted();return {root,base,directory,archiveSha256:image.sha256,content:expected};
  }finally{
    try{if(staging){for(const mount of stagingMounts)try{const cleanupContext={...context,signal:undefined};
      if((await attachments(run,cleanupContext)).some(image=>image['system-entities']?.some(row=>row['mount-point']===mount)))
        await run('/usr/bin/hdiutil',['detach',mount],{context:cleanupContext});
      stagingMounts.delete(mount);
    }catch{}
      if(stagingMounts.size===0)await fs.promises.rm(staging,{recursive:true,force:true});
    }}finally{await release();}
  }
  };
  return !exists(base)&&!candidate?runDownloadTask(context.downloads||context.downloadManager,
    {label:'Android system image',managerId:'android-system-image',sectionId:'default',version:image.sha256,kind:'runtime',dedupeKey:'android-system-image:'+directory},
    acquire,{onProgress:context.onProgress}):acquire();
}

/** AIM keeps its original overlay/helper/data flow. Its base can be an alias
 * of the same immutable original already acquired for the ART engine. */
async function adoptBase({context,image,destination},dependencies={}){
  if(!SHA.test(image?.sha256||'')||!path.isAbsolute(destination||''))throw Error('The Android image cache destination is invalid.');
  Writable.assertOwnDirectory(context.userDataDir,path.dirname(destination),{create:false});
  if(exists(destination)){await regular(destination);return true;}
  const directory=path.join(context.userDataDir,'android/system-images',image.sha256),receiptFile=path.join(directory,'image.json');
  Writable.assertOwnDirectory(context.userDataDir,directory,{create:false});
  if(!exists(receiptFile))return false;
  await regular(receiptFile,8192);const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
  if(receipt.archiveSha256!==image.sha256)throw Error('The Android image cache belongs to a different original image.');
  const original=await prepare({context,image,expected:receipt.content,existingOnly:true},dependencies);
  if(!original)return false;
  Writable.assertOwnDirectory(context.userDataDir,path.dirname(destination));
  const temporary=path.join(path.dirname(destination),'.image-adopt-'+crypto.randomUUID());
  try{await fs.promises.copyFile(original.base,temporary,fs.constants.COPYFILE_FICLONE|fs.constants.COPYFILE_EXCL);await fs.promises.chmod(temporary,0o400);
    try{await fs.promises.link(temporary,destination);}catch(error){if(error.code!=='EEXIST')throw error;await regular(destination);}
  }finally{await fs.promises.rm(temporary,{force:true});}
  return true;
}
module.exports={prepare,adoptBase,contentIdentity,hashFile,command};
