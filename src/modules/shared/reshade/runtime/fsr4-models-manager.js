// Copyright (c) MacLauncher contributors. MIT license.
const Library=require('../temporal/fsr4/models'),{descriptor}=Library;
const options=context=>({...context,root:context.root||require('..').runtimeRoot(context.app)});
// Runtimes installs both 4.1.2 profiles; a game that selects one downloads only what that profile needs.
const managed=context=>({...options(context),fsr4Profile:context.fsr4Profile||'int8-lite-lossy'});
const PROFILES=[{id:'int8-lite',label:'FSR 4.1.2 Lite'},{id:'int8-lite-lossy',label:'FSR 4.1.2 Lite Lossy'}];
const complete=current=>PROFILES.every(profile=>current?.profiles.includes(profile.id));
const installedLabel=current=>current.profiles.includes('int8-lite-lossy')?'FSR 4.1.2 Lite and Lite Lossy':'FSR 4.1.2 Lite';
const bothBytes=descriptor.downloadBytes+require('../temporal/fsr4/model.json').lossy.archiveBytes;
function getState(context={}){
 const current=Library.read(context.userDataDir),provider=require('../temporal/fsr4').inspect(context.root||require('..').runtimeRoot(context.app));
 const available=provider?.profiles.includes('int8-lite')===true;
 const catalog={status:'success',delivery:'download',versions:[descriptor.version],versionLabels:{[descriptor.version]:'FSR 4.1.2 Lite and Lite Lossy'},
  installable:available,installableVersions:available?[descriptor.version]:[],includedVersions:[],buildableVersions:[],
  versionRequirements:{[descriptor.version]:{requiresDownload:!complete(current),requiresBuild:false,available:complete(current),included:false,downloadBytes:bothBytes,
   ...(!available?{reason:'The selected graphics processor does not include FSR 4.1.2 Lite.'}:{})}},
  importable:available,importInputKinds:['file','directory'],importExtensions:['zip'],importLabel:'Import FSR 4 model data…',
  importDescription:'Imports the original fsr4-native-macos v3.2 release zip or its fsr412_model directory. A sibling fsr412_lossy directory supplies Lite Lossy data.',
  sourceUrl:descriptor.sourceUrl,source:descriptor.sourceUrl,refreshLabel:'Reload available model data',supportsLatestOnly:false,fetchedAt:null,error:null,
  latestInstalledVersion:current?.version||null,latestAvailableVersion:descriptor.version,updateAvailable:false};
 const section={id:'default',label:'FSR 4 models',managementTitle:descriptor.label,supportsDefault:false,installed:current?[{...current,runtimePath:current.directory,sourcePath:current.directory,versionLabel:installedLabel(current),removalLabel:'Remove'}]:[],variants:[],capabilities:PROFILES.map(profile=>({...profile,available:current?.profiles.includes(profile.id)===true})),installing:null,catalog,sourceLinks:[{label:'Upstream release',url:descriptor.sourceUrl}],description:'AMD FSR 4.1.2 model data for the FSR 4 4.1.2 Lite and Lite Lossy profiles, from the fsr4-native-macos release. It is downloaded or imported, then prepared in the launcher profile.'};
 return {...section,id:descriptor.managerId,sections:[section]};
}
// The model data a Play's FSR 4 row with this profile needs, when it is missing. Reading it is offline.
function launchPlan(context={},profile){
 if(!PROFILES.some(item=>item.id===profile)||Library.read(context.userDataDir)?.profiles.includes(profile)||getState(context).catalog.installable!==true)return null;
 return {managerId:descriptor.managerId,version:descriptor.version,label:descriptor.label,bytes:profile==='int8-lite-lossy'?bothBytes:descriptor.downloadBytes,installOptions:{sectionId:'default',fsr4Profile:profile}};
}
async function remove(context={}){const root=Library.directory(context.userDataDir);require('../../writable-input').assertOwnDirectory(context.userDataDir,root,{create:false});return require('../../../../core/coordinated-runtime-managers').withRuntimeMutation({...descriptor,sourcePath:root},()=>require('node:fs').promises.rm(root,{recursive:true,force:true}),{userDataDir:context.userDataDir});}
module.exports={id:descriptor.managerId,label:'FSR 4 models',distributionRequired:false,delivery:{included:'none',catalog:'declared',sourceBuild:false},
 ui:{groupId:'graphics',tabLabel:'Graphics',sectionLabel:'FSR 4 models',order:0,memberOrder:7,management:'managed'},getState,launchPlan,normalizeSettings:()=>({}),installRuntime:context=>Library.install(managed(context)),
 coordinateImportRuntime:context=>Library.importRuntime(options(context)),importRuntime:context=>Library.importRuntime(options(context)),uninstallRuntime:remove,refreshCatalog:async context=>getState(context).catalog,
 performSetupAction:context=>{if(context.setupActionId==='download')return Library.install(managed(context));throw Error('Choose an available FSR 4 model action.');},core:Library};
