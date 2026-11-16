// Copyright (c) MacLauncher contributors. MIT license.
const Library=require('../temporal/fsr4/models'),{descriptor}=Library;
const options=context=>({...context,root:context.root||require('..').runtimeRoot(context.app)});
function getState(context={}){
 const current=Library.read(context.userDataDir),provider=require('../temporal/fsr4').inspect(context.root||require('..').runtimeRoot(context.app));
 const available=provider?.profiles.includes('int8-lite')===true;
 const catalog={status:'success',delivery:'download',versions:[descriptor.version],versionLabels:{[descriptor.version]:'FSR 4.1.2 Lite'},
  installable:available,installableVersions:available?[descriptor.version]:[],includedVersions:[],buildableVersions:[],
  versionRequirements:{[descriptor.version]:{requiresDownload:!current,requiresBuild:false,available:!!current,included:false,downloadBytes:descriptor.downloadBytes,
   ...(!available?{reason:'Install an FSR 4 v3.2 provider first.'}:{})}},
  importable:available,importInputKinds:['file','directory'],importExtensions:['zip'],importLabel:'Import FSR 4 model data…',
  importDescription:'Imports the original fsr4-native-macos v3.2 release zip or its fsr412_model directory. A sibling fsr412_lossy directory supplies Lite Lossy data.',
  sourceUrl:descriptor.sourceUrl,source:descriptor.sourceUrl,refreshLabel:'Reload available model data',supportsLatestOnly:false,fetchedAt:null,error:null,
  latestInstalledVersion:current?.version||null,latestAvailableVersion:descriptor.version,updateAvailable:false};
 const section={id:'default',label:'FSR 4 models',managementTitle:descriptor.label,supportsDefault:false,installed:current?[{...current,runtimePath:current.directory,sourcePath:current.directory,versionLabel:'FSR 4.1.2 Lite',removalLabel:'Remove'}]:[],variants:[],installing:null,catalog,sourceLinks:[{label:'Upstream release',url:descriptor.sourceUrl}]};
 return {...section,id:descriptor.managerId,sections:[section]};
}
async function remove(context={}){const root=Library.directory(context.userDataDir);require('../../writable-input').assertOwnDirectory(context.userDataDir,root,{create:false});return require('../../../../core/coordinated-runtime-managers').withRuntimeMutation({...descriptor,sourcePath:root},()=>require('node:fs').promises.rm(root,{recursive:true,force:true}),{userDataDir:context.userDataDir});}
module.exports={id:descriptor.managerId,label:'FSR 4 models',distributionRequired:false,delivery:{included:'none',catalog:'declared',sourceBuild:false},
 ui:{groupId:'graphics',tabLabel:'Graphics',sectionLabel:'FSR 4 models',order:0,memberOrder:7,management:'managed'},getState,normalizeSettings:()=>({}),installRuntime:context=>Library.install(options(context)),
 coordinateImportRuntime:context=>Library.importRuntime(options(context)),importRuntime:context=>Library.importRuntime(options(context)),uninstallRuntime:remove,refreshCatalog:async context=>getState(context).catalog,
 performSetupAction:context=>{if(context.setupActionId==='download')return Library.install(options(context));throw Error('Choose an available FSR 4 model action.');},core:Library};
