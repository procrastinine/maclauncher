const fs = require('node:fs'), path = require('node:path');
const Images = require('./system-image'), Inspection = require('./image-inspection');
const Catalog = require('../shared/runtime/runtime-catalog'), Custom = require('../shared/runtime/custom-runtime');
const {selectRuntimeVersion,managerDefaultVersion} = require('../shared/runtime/version-choices');
const {confirmToolInstall,approveDownloads} = require('../shared/runtime/tool-install');
const {runDownloadTask} = require('../shared/runtime/download-manager');
const Upstream = require('../shared/runtime/upstream');
const Writable = require('../shared/writable-input');
const {withRuntimeMutation} = require('../../core/coordinated-runtime-managers');
const Origins = require('../../core/runtime-install-origins');
const ID = 'android-system-image', SHA = /^[a-f0-9]{64}$/;
const stamp = file => {const s=fs.statSync(file,{bigint:true});return [s.dev,s.ino,s.size,s.mode,s.mtimeNs,s.ctimeNs].join(':');};
const sameContent = (a,b) => a&&b&&['sha256','records','bytes'].every(key=>a[key]===b[key]);
const parent = userDataDir => path.join(userDataDir,'android/system-images');
const read = file => {try {const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>65536)return null;return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}};
const validSource = row => typeof row?.version==='string'&&row.version.length<256&&Array.isArray(row.files)&&row.files.length===1&&/^https:\/\//.test(row.files[0]?.url||'');
function normalizeSettings(settings) {return {defaultVersion:typeof settings?.defaultVersion==='string'?settings.defaultVersion:null};}
async function use(context,identity) {if(context.useRuntime)await context.useRuntime(identity);else context.recordRuntimeUse?.(identity);}

function createManager(dependencies = {}) {
  const source=dependencies.source||require('./image-catalog').source, helper=dependencies.extractorManager||require('./image-extractor-manager');
  const imageDependencies=dependencies.imageDependencies||{};
  const catalog = userDataDir => Catalog.readRuntimeCatalog({userDataDir,managerId:ID,validateEntry:validSource,maxEntries:2000});
  const sources = userDataDir => catalog(userDataDir)?.entries||[];
  function listInstalled(userDataDir) {
    if(!userDataDir)return [];
    const directory=parent(userDataDir);Writable.assertOwnDirectory(userDataDir,directory,{create:false});
    let names;try{names=fs.readdirSync(directory).filter(name=>SHA.test(name));}catch(error){if(error.code==='ENOENT')return [];throw error;}
    return names.flatMap(name=>{
      const root=path.join(directory,name);try{Writable.assertOwnDirectory(directory,root,{create:false});}catch{return [];}
      const receipt=read(path.join(root,'image.json')),record=read(path.join(root,'managed-image.json'));
      const validReceipt=receipt?.schemaVersion===1&&receipt.archiveSha256===name&&SHA.test(receipt.dmgSha256||'');
      const base=path.join(root,'system.dmg');let ready=false;
      try {const stat=fs.lstatSync(base);ready=validReceipt&&stat.isFile()&&!stat.isSymbolicLink()&&!(stat.mode&0o222)&&
        record?.schemaVersion===1&&record.baseIdentity===stamp(base)&&record.receiptIdentity===stamp(path.join(root,'image.json'))&&
        ['arm64','x64','arm','x86'].includes(receipt.guest?.architecture)&&receipt.guest.files?.length===Inspection.REQUIRED.length;}catch{}
      const versions=record?.versions||[record?.version||name];
      if(!Array.isArray(versions)||!versions.length||versions.length>256||versions.some(value=>typeof value!=='string'||!value||value.length>256))return [];
      return versions.map(version=>({version,sectionId:'default',installDir:root,directory:root,base,archiveSha256:name,
        content:receipt?.content,guestArchitecture:receipt?.guest?.architecture,architecture:receipt?.guest?.architecture,
        image:record?.image,ready,status:ready?'ready':'incomplete',requiresRosetta:false,
        ...(!ready?{reason:'Verify the original Android image with Install before using this copy.'}:{})}));
    });
  }
  function selection(entry,settings,userDataDir,options={}) {
    const installed=listInstalled(userDataDir),rows=sources(userDataDir),choice=Custom.defaultVersion(settings,ID);
    // A saved default that is neither installed nor listed any more gives way to the ordinary choice.
    const saved=!rows.length&&!installed.length||installed.some(row=>row.version===choice)||rows.some(row=>row.version===choice)?choice:null;
    const chosen=selectRuntimeVersion({manual:options.version,defaultVersion:saved,
      fallback:managerDefaultVersion({installed:installed.filter(row=>row.ready).map(row=>row.version),listed:rows.map(row=>row.version)})});
    const install=installed.find(row=>row.version===chosen.version&&row.ready)||null;
    return {version:chosen.version,install,ready:Boolean(install),automatic:!selectRuntimeVersion({manual:options.version}).version&&!saved,
      requiresDownload:!install,discoveryRequired:!rows.length&&!install,reason:install?null:'The Android system image is not installed.'};
  }
  function getState(context={}) {
    const installed=listInstalled(context.userDataDir),rows=sources(context.userDataDir),state=catalog(context.userDataDir),settings=normalizeSettings(context.settings);
    const versions=[...new Set([...rows.map(row=>row.version),...installed.map(row=>row.version)])];
    const section={id:'default',label:'Android system images',supportsDefault:true,defaultVersion:settings.defaultVersion,
      registrationPresentation:{label:'Use existing image…',description:'Registers an extracted Android image root or its system linker file. The original files remain in place.'},
      installed,variants:[],catalog:{status:state?'success':'idle',versions,installable:true,installableVersions:rows.map(row=>row.version),
        versionLabels:Object.fromEntries(rows.map(row=>[row.version,row.label||row.version])),supportsLatestOnly:false,
        versionRequirements:Object.fromEntries(versions.map(version=>[version,{requiresDownload:!installed.some(row=>row.version===version&&row.ready),requiresBuild:false}])),
        sourceUrl:'https://developer.android.com/studio/run/managing-avds',refreshLabel:'Refresh Android SDK images',fetchedAt:state?.fetchedAt||null},
      description:'Original Android SDK images. The selected Android runtime accepts only its matching original image and guest CPU.'};
    return {...section,id:ID,sections:[section]};
  }
  async function publish(prepared,version,image,userDataDir) {
    const file=path.join(prepared.directory,'managed-image.json');
    const updated=prior=>{
      const versions=[...new Set([...(prior?.versions||[prior?.version].filter(Boolean)),version])];
      if(versions.length>256)throw Error('The Android image has too many registered version names.');
      return {schemaVersion:1,version:prior?.version||version,versions,image:prior?.image?.sha256===image.sha256?prior.image:image,
        baseIdentity:stamp(prepared.base),receiptIdentity:stamp(path.join(prepared.directory,'image.json'))};
    };
    const prior=read(file);
    if(JSON.stringify(prior)!==JSON.stringify(updated(prior)))await withRuntimeMutation({managerId:ID,version,sectionId:'default',sourcePath:prepared.directory},async()=>{
      const current=read(file),record=updated(current);
      if(JSON.stringify(current)!==JSON.stringify(record))Writable.atomicWrite(file,JSON.stringify(record)+'\n',{root:prepared.directory});
    },{userDataDir});
    return {...prepared,version,sectionId:'default',installDir:prepared.directory,architecture:prepared.guest.guestArchitecture,
      guestArchitecture:prepared.guest.guestArchitecture,ready:true,requiresRosetta:false,image};
  }
  async function extractor(context) {
    if(context.imageExtractor)return context.imageExtractor;
    let selected=helper.resolveSelection(null,context.settings,context.userDataDir);
    if(!selected.ready){
      if(!selected.version||selected.discoveryRequired){await helper.refreshCatalog({...context,force:true});selected=helper.resolveSelection(null,context.settings,context.userDataDir);}
      const installed=await helper.installRuntime({...context,version:selected.version,automatic:context.automatic===true&&selected.automatic===true});
      selected={...selected,install:installed,ready:true};
    }
    await use(context,{managerId:helper.id,version:selected.version,sectionId:'default',sourcePath:selected.install.installDir});
    return selected.install.executablePath;
  }
  async function installRuntime(context={}) {
    const before=listInstalled(context.userDataDir),chosen=selection(null,context.settings,context.userDataDir,{version:context.version});
    if(chosen.ready&&!context.requiredImage)return chosen.install;
    let row=sources(context.userDataDir).find(row=>row.version===chosen.version);
    if(!row&&!context.requiredImage){await manager.refreshCatalog({...context,force:true});row=sources(context.userDataDir).find(row=>row.version===(context.version||selection(null,context.settings,context.userDataDir).version));}
    const required=context.requiredImage;
    if(!row&&!required)throw Error('The selected Android system image is unavailable. Refresh its upstream versions.');
    const version=required?.version||row?.version||required.sha256;
    const wanted=required?.sha256||(row.files[0].digest?.algorithm==='sha256'?row.files[0].digest.value:null),held=before.find(item=>item.archiveSha256===wanted);
    if(required||held){
      const image=required||held.image||{url:row.files[0].url,sha256:wanted,bytes:row.files[0].bytes,version};
      const cached=await Images.prepare({context,image,expected:context.expectedContent,recordContent:true,existingOnly:true},imageDependencies);
      if(cached){
        if(context.guestArchitecture&&cached.guest.guestArchitecture!==context.guestArchitecture)throw Error('The Android image guest CPU differs from its selected runtime.');
        return publish(cached,version,image,context.userDataDir);
      }
    }
    if(held)throw Error('The Android image installation is incomplete. Remove that copy before installing it again.');
    const helperPath=await extractor(context);
    const installed=await runDownloadTask(context.downloads||context.downloadManager,{managerId:ID,version,sectionId:'default',kind:'runtime',label:'Android system image',dedupeKey:`${ID}:${context.userDataDir}:${version}`},async task=>{
      const signal=context.signal&&task.signal?AbortSignal.any([context.signal,task.signal]):context.signal||task.signal;
      const active={...context,signal,onProgress:task.onProgress,confirmRuntimeInstall:approveDownloads};
      const directory=parent(context.userDataDir);Writable.assertOwnDirectory(context.userDataDir,directory);
      const temporary=fs.mkdtempSync(path.join(directory,'.download-')),archive=path.join(temporary,'image.zip');
      try {
        const listed=required?Upstream.listedFile({url:required.url,filename:path.basename(new URL(required.url).pathname),bytes:required.bytes||required.size,sha256:required.sha256}):row.files[0];
        const download=await Upstream.download(listed,archive,{signal,onProgress:task.onProgress});
        const image=required||{url:listed.url,sha256:download.sha256,bytes:fs.statSync(archive).size,version,licenseUrl:'https://developer.android.com/studio/terms'};
        const abi=row?.details?.abi,guest=context.guestArchitecture||({ 'arm64-v8a':'arm64',x86_64:'x64',x86:'x86','armeabi-v7a':'arm'})[abi];
        const inspection={...imageDependencies,inspectRoot(root){const facts=(imageDependencies.inspectRoot||Inspection.inspectRoot)(root);
          if(guest&&facts.guestArchitecture!==guest)throw Error('The Android SDK image guest CPU differs from its publisher metadata.');return facts;}};
        const prepared=await Images.prepare({context:active,image,expected:context.expectedContent,extractor:helperPath,archiveFile:archive,recordContent:true},inspection);
        return publish(prepared,version,image,context.userDataDir);
      } finally {fs.rmSync(temporary,{recursive:true,force:true});}
    },{onProgress:context.onProgress});
    if(context.automatic===true)Origins.recordPlayInstall({userDataDir:context.userDataDir,manager,plan:{version,automatic:true},result:installed,entry:context.entry,
      settings:context.settings,installedBefore:before,logger:context.logger});
    return installed;
  }
  async function remove(context) {
    const installed=listInstalled(context.userDataDir).find(row=>row.version===context.version);
    if(!installed)throw Error('The Android system image is not installed.');
    return withRuntimeMutation({managerId:ID,version:installed.version,sectionId:'default',sourcePath:installed.installDir},async()=>{
      const file=path.join(installed.installDir,'managed-image.json'),record=read(file);
      const versions=record?.versions?.filter(version=>version!==installed.version);
      if(versions?.length){Writable.atomicWrite(file,JSON.stringify({...record,versions,version:versions[0]})+'\n',{root:installed.installDir});return true;}
      await Images.remove({context,directory:installed.installDir},imageDependencies);return true;
    },{userDataDir:context.userDataDir});
  }
  const manager={id:ID,label:'Android system images',distributionRequired:false,delivery:{included:'none',catalog:'remote',sourceBuild:false},
    ui:{groupId:'tools',tabLabel:'Tools',sectionLabel:'Android system images',order:200,memberOrder:280,management:'managed'},
    normalizeSettings,getState,resolveSelection:selection,installRuntime:context=>withRuntimeMutation({managerId:ID,sectionId:'default',
      ...(context.version?{version:context.version}:{}),...(context.requiredImage?.sha256?{sourcePath:path.join(parent(context.userDataDir),context.requiredImage.sha256)}:{})},
      ()=>installRuntime(context),{userDataDir:context.userDataDir}),uninstallRuntime:remove,
    async refreshCatalog(context={}) {const entries=await source.discover({...context,latestOnly:false});
      // An answer that lists no image is not a release list; the earlier list stays.
      if(!entries.length)throw Error('Google\'s Android image catalog listed no system images. Refresh again later.');
      Catalog.writeRuntimeCatalog({userDataDir:context.userDataDir,managerId:ID,source:source.locations?.[0],entries,maxEntries:2000});return getState(context).catalog;},
    applySettingsUpdate:(action,payload,settings)=>action==='setDefault'?normalizeSettings({...settings,defaultVersion:payload.version}):normalizeSettings(settings),
    updateSettingsAfterInstall:(settings,installed)=>normalizeSettings(settings).defaultVersion?settings:{...settings,defaultVersion:installed.version},
    updateSettingsAfterUninstall:(settings,_payload,context)=>listInstalled(context.userDataDir).some(row=>row.version===settings?.defaultVersion)?settings:{...settings,defaultVersion:null},
    core:{listInstalled,sources}};
  Custom.configure(manager,{defaultsPath:()=>['defaultVersion'],
    prepare:async(input,{signal})=>({content:await Images.contentIdentity(Inspection.inspectRoot(input).root,signal)}),
    inspect(input,{data}={}) {return {...Inspection.inspectRoot(input),content:data?.content,ready:true};}});
  Custom.instrumentManagers([manager]);
  manager.requirements=(context,{image,expected,extractor:helperPath,guestArchitecture}={})=>{
    const saved=Custom.defaultVersion(context.settings,ID),custom=Custom.isPath(saved)&&Custom.forManager(manager).resolve(context.userDataDir,saved,'default');
    if(custom&&sameContent(custom.content,expected)){
      if(guestArchitecture&&custom.guestArchitecture!==guestArchitecture)throw Error('The Android image guest CPU differs from its selected runtime.');
      context.recordRuntimeUse?.({managerId:ID,version:custom.version,sectionId:'default',sourcePath:custom.installDir});return [];
    }
    const existing=listInstalled(context.userDataDir).find(row=>row.archiveSha256===image.sha256);
    if(existing?.ready&&guestArchitecture&&existing.guestArchitecture!==guestArchitecture)throw Error('The Android image guest CPU differs from its selected runtime.');
    if(existing?.ready){context.recordRuntimeUse?.({managerId:ID,version:existing.version,sectionId:'default',sourcePath:existing.installDir});return [];}
    const reader=helperPath?null:helper.resolveSelection(null,context.settings,context.userDataDir);
    const legacy=require('./providers/aim/image-storage').imageDirectories(context.userDataDir).some(directory=>{
      try{return fs.lstatSync(path.join(directory,'system.dmg')).isFile()&&fs.readFileSync(path.join(directory,'system/root.identity'),'utf8').trim()===image.sha256;}catch{return false;}});
    const download=!existing&&!legacy,version=image.version||image.sha256;
    return [{managerId:ID,version,automatic:Custom.defaultVersion(context.settings,ID)!==version,requiresDownload:download,
      licenseRequired:true,licenseUrl:image.licenseUrl||'https://developer.android.com/studio/terms',
      installOptions:{requiredImage:image,expectedContent:expected,imageExtractor:helperPath,guestArchitecture}},
      ...(download&&!helperPath&&!reader.ready?[{managerId:helper.id,version:reader.version||null,...(reader.discoveryRequired?{discoveryRequired:true}:{}),
        automatic:reader.automatic===true,requiresDownload:true,installOptions:{}}]:[])];
  };
  manager.ensure=async(context,{image,expected,extractor:helperPath,existingOnly=false,guestArchitecture}={})=>{
    const checked=prepared=>{if(guestArchitecture&&prepared.guest?.guestArchitecture!==guestArchitecture)throw Error('The Android image guest CPU differs from its selected runtime.');return prepared;};
    const installed=listInstalled(context.userDataDir),matching=installed.find(row=>row.archiveSha256===image.sha256&&row.ready);
    const expectedContent=expected||matching?.content;
    const saved=Custom.defaultVersion(context.settings,ID);
    const custom=Custom.isPath(saved)&&Custom.forManager(manager).resolve(context.userDataDir,saved,'default');
    let prepared;
    if(custom&&expectedContent&&sameContent(await Images.contentIdentity(custom.root,context.signal),expectedContent)){
      prepared=checked(await Images.prepare({context,image,expected:expectedContent,sourceRoot:custom.root,recordContent:true},imageDependencies));
      prepared=await publish(prepared,matching?.version||image.version||image.sha256,image,context.userDataDir);
      await use(context,{managerId:ID,version:prepared.version,sectionId:'default',sourcePath:prepared.installDir});
      await use(context,{managerId:ID,version:custom.version,sectionId:'default',sourcePath:custom.installDir});
      return {...prepared,version:custom.version,external:true};
    }
    const cached=await Images.prepare({context,image,expected:expectedContent,existingOnly:true,recordContent:true},imageDependencies);
    if(cached){prepared=await publish(checked(cached),matching?.version||image.version||image.sha256,image,context.userDataDir);}
    else if(existingOnly)return null;
    else {
      const helperSelected=helperPath?null:helper.resolveSelection(null,context.settings,context.userDataDir);
      const requirements=[{managerId:ID,version:image.version||image.sha256,label:'Android system image',requiresDownload:true},
        ...(!helperPath&&!helperSelected.ready?[{managerId:helper.id,version:helperSelected.version,label:helper.label,requiresDownload:true}]:[])];
      await (imageDependencies.confirm||confirmToolInstall)(context,{manager,version:image.version||image.sha256,requiresDownload:true,
        licenseRequired:true,licenseUrl:image.licenseUrl||'https://developer.android.com/studio/terms',
        message:'The selected Android runtime requires its original system image.',detail:requirements.map(row=>row.label).join(' and ')+'. Android SDK terms: '+(image.licenseUrl||'https://developer.android.com/studio/terms'),installOptions:{requirements}});
      prepared=await manager.installRuntime({...context,version:image.version||image.sha256,requiredImage:image,expectedContent:expected,
        imageExtractor:helperPath,guestArchitecture,automatic:typeof context.automatic==='boolean'?context.automatic:saved!==image.version&&saved!==image.sha256,confirmRuntimeInstall:approveDownloads});
    }
    await use(context,{managerId:ID,version:prepared.version,sectionId:'default',sourcePath:prepared.installDir});
    return prepared;
  };
  return manager;
}
module.exports=Object.assign(createManager(),{createManager,prepare({context,...options},imageDependencies){
  return (imageDependencies?createManager({imageDependencies}):module.exports).ensure(context,options);
}});
