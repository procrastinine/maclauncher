// Copyright (c) MacLauncher contributors. MIT license.
const Library=require('../generation/anr/library'),Provider=require('../generation/anr'),Custom=require('../../runtime/custom-runtime');
const {Source,Releases}=Library,{selectRuntimeVersion,managerDefaultVersion,savedDefaultVersion}=require('../../runtime/version-choices');
const root=context=>context.root||require('..').runtimeRoot(context.app);
const unsupported='Requires Apple Silicon, macOS 26 or later and a graphics processor that includes Apex Neural Rendering.';
function normalizeSettings(value){return {defaultVersion:typeof value?.defaultVersion==='string'&&(Releases.validVersion(value.defaultVersion)||Custom.isPath(value.defaultVersion))?value.defaultVersion:null};}
// The version a Play or an install uses: the explicit choice, the saved
// default, a ready installed version, then the newest listed release. A saved
// default that is not installed gives way to a ready installed version, so an
// installed usable version never asks for a download, and one that upstream
// no longer lists gives way to the manager's default.
function selection(context={}){
 const settings=context.settings?.runtimes?context.settings:{runtimes:{[Source.managerId]:context.settings}};
 const saved=Custom.defaultVersion(settings,Source.managerId),installed=Library.listInstalled(context.userDataDir),sources=Releases.sources(context.userDataDir);
 const manual=selectRuntimeVersion({manual:context.version}).version,versions=installed.map(row=>row.version);
 const usable=savedDefaultVersion(saved,{listed:sources.map(row=>row.version),installed:versions});
 const preferred=usable&&(Custom.isPath(usable)||!installed.length||versions.includes(usable))?usable:null;
 const chosen=selectRuntimeVersion({manual,defaultVersion:preferred,fallback:managerDefaultVersion({installed:installed.map(row=>row.version),listed:sources.map(row=>row.version)})});
 if(Custom.isPath(chosen.version))return {...chosen,saved,automatic:false,current:Custom.forManager(module.exports).resolve(context.userDataDir,chosen.version,'default')};
 return {...chosen,saved,automatic:!manual&&!preferred,current:installed.find(row=>row.version===chosen.version)||null,sourceSpec:Releases.source(context.userDataDir,chosen.version)};
}
function getState(context={}){
 const installed=Library.listInstalled(context.userDataDir).map(row=>({...row,description:'Frame generation · 1080p, 1440p, 2160p',removalLabel:'Remove',removalConfirm:'Remove the prepared ANR '+row.version+' models?'}));
 const sourceRows=Releases.sources(context.userDataDir),sources=new Map(sourceRows.map(row=>[row.version,row])),cached=Releases.read(context.userDataDir);
 const versions=[...new Set([...sources.keys(),...installed.map(row=>row.version)])].sort((a,b)=>Releases.newest({version:a},{version:b}));
 const provider=Provider.resolve(root(context),context),reason=provider?null:unsupported,selected=selection(context);
 const catalog={status:cached?'success':'idle',delivery:'download',versions,versionLabels:Object.fromEntries(versions.map(version=>[version,'Apex Neural Rendering '+version])),
  installable:Boolean(provider),installableVersions:provider?[...sources.keys()]:[],includedVersions:[],buildableVersions:[],
  versionRequirements:Object.fromEntries(versions.map(version=>{const ready=installed.some(row=>row.version===version),source=sources.get(version);
   return [version,{requiresDownload:!ready,requiresBuild:false,available:ready,included:false,...(source&&!ready?{downloadBytes:source.archiveBytes}:{downloadBytes:0}),...(reason?{reason}:{})}];})),
  importable:Boolean(provider),importInputKinds:['directory','file'],importExtensions:['gz'],importLabel:'Import ANR macOS kit…',importDescription:'Prepares and verifies a macOS kit of a listed release. Original files remain unchanged. A prepared model directory can also be registered in place.',
  sourceUrl:Releases.sourceUrl,source:Releases.sourceUrl,refreshLabel:'Refresh upstream releases',supportsLatestOnly:false,
  latestInstalledVersion:installed[0]?.version||null,latestAvailableVersion:sourceRows[0]?.version||null,updateAvailable:false,fetchedAt:cached?.fetchedAt||null,error:null};
 const section={id:'default',label:'Apex Neural Rendering',managementTitle:'Apex Neural Rendering',supportsDefault:true,
  defaultVersion:selected.saved||null,defaultSource:selected.saved?'saved':'manager',
  installed,variants:[],installing:null,catalog,sourceLinks:[{label:'Apex releases',url:Releases.sourceUrl}],
  description:'Apex Neural Rendering frame-generation models for 1920×1080, 2560×1440 and 3840×2160 output. The macOS kit of the selected release is downloaded or imported, prepared in the launcher profile and checked against its reference frames; the downloaded kit is removed afterwards.'};
 return {...section,id:Source.managerId,sections:[section]};
}
// The kit a Play's ANR row needs when no usable version is installed. Reading it is offline.
function launchPlan(context={}){
 const chosen=selection(context);
 if(chosen.current?.ready||!chosen.sourceSpec||!Provider.resolve(root(context),context))return null;
 return {managerId:Source.managerId,version:chosen.version,label:'Apex Neural Rendering',automatic:chosen.automatic,bytes:chosen.sourceSpec.archiveBytes,installOptions:{sectionId:'default'}};
}
async function installRuntime(context={}){
 const chosen=selection(context);
 if(chosen.current?.ready)return Library.use(chosen.current,context);
 if(Custom.isPath(chosen.version))throw Error('The selected Apex Neural Rendering model directory is unavailable. Check its path in Runtimes.');
 if(!chosen.sourceSpec)throw Error('Refresh Apex Neural Rendering releases or choose an installed version.');
 return Library.install({...context,root:root(context),sourceSpec:chosen.sourceSpec});
}
function importRuntime(context={}){return Library.importRuntime({...context,root:root(context)});}
module.exports={id:Source.managerId,label:'Apex Neural Rendering',distributionRequired:false,delivery:{included:'none',catalog:'remote',sourceBuild:false},
 ui:{groupId:'graphics',tabLabel:'Graphics',sectionLabel:'Apex Neural Rendering',order:0,memberOrder:8,management:'managed'},
 normalizeSettings,getState,selection,launchPlan,installRuntime,importRuntime,coordinateImportRuntime:importRuntime,
 uninstallRuntime:context=>Library.remove({...context,version:context.version||selection(context).version}),
 refreshCatalog:async context=>{await Releases.refresh(context);return getState(context).catalog;},
 applySettingsUpdate:(action,payload,settings)=>action==='setDefault'?normalizeSettings({...settings,defaultVersion:payload.version}):normalizeSettings(settings),
 performSetupAction:context=>{if(context.setupActionId==='download')return installRuntime(context);throw Error('Choose an available ANR action.');},core:Library};
Custom.configure(module.exports,{defaultsPath:()=>['defaultVersion'],inspect:Library.inspectCustom});
