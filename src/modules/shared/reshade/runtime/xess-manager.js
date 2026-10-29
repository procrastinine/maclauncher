const Library=require("../xess/library"),{downloadApproved,approveDownloads}=require("../../runtime/tool-install");
const {Source,Components}=Library;
const versionLabel="Intel XeSS SDK · "+Source.commit.slice(0,8);
function normalizeSettings(value){const version=typeof value?.defaultVersion==="string"?value.defaultVersion.trim():"";return {defaultVersion:version&&version!=="auto"?version:null};}
function provider(context){return require("../xess").resolve(context.root||require("..").runtimeRoot(context.app),{platform:context.platform});}
function requiredOperations(selected){return ["superresolution",...(selected?.generation?["interpolate"]:[])];}
function missingBytes(installed,selected){const capabilities=installed?.capabilities||[];return (capabilities.includes("superresolution")?0:Source.bytes)+(selected?.generation&&!capabilities.includes("interpolate")?Components.files.reduce((sum,row)=>sum+row.bytes,0):0);}
function getState(context={}){
  const {userDataDir,settings}=context,selected=provider(context),required=requiredOperations(selected);
  const copies=Library.listInstalled(userDataDir),installed=copies.map(row=>({...row,versionLabel,
    description:row.capabilities.map(value=>value==="interpolate"?"Frame generation and XeLL":"Super resolution").join(" · "),
    missingComponents:required.filter(value=>!row.capabilities.includes(value)),removalLabel:"Remove",
    removalConfirm:row.external?"Remove the XeSS runtime registration? Original DLLs remain unchanged.":"Remove the managed XeSS runtime files?"}));
  const current=installed.find(row=>row.version===Source.version),complete=Boolean(current&&!current.missingComponents.length),bytes=missingBytes(current,selected);
  const catalog={status:"success",delivery:"download",versions:[Source.version],versionLabels:{[Source.version]:versionLabel},
    installable:Boolean(selected),installableVersions:selected?[Source.version]:[],includedVersions:[],buildableVersions:[],
    versionRequirements:{[Source.version]:{requiresDownload:!complete,requiresBuild:false,available:complete,included:false,
      downloadBytes:bytes,installLabel:current?"Complete install":"Install",...(!selected?{reason:"The selected graphics package does not include the XeSS adapter."}:{})}},
    importable:true,importInputKinds:["file","directory"],importExtensions:["dll"],importLabel:"Import XeSS files…",
    importDescription:"Registers compatible original Intel DLLs in place. Selecting libxess_fg.dll or its folder also registers the required XeLL companion.",
    sourceUrl:Source.sourceUrl,source:Source.sourceUrl,refreshLabel:"Reload available runtime",supportsLatestOnly:false,fetchedAt:null,error:null,
    latestInstalledVersion:current?.version||null,latestAvailableVersion:Source.version,updateAvailable:Boolean(current&&!complete)};
  const section={id:"default",label:"XeSS",managementTitle:"Intel XeSS runtime",supportsDefault:true,installed,variants:[],installing:null,catalog,
    defaultVersion:normalizeSettings(settings).defaultVersion,
    sourceLinks:[{label:"Official downloads",url:"https://github.com/intel/xess/releases"},{label:"Source",url:Source.sourceUrl}],
    description:"Original Intel runtime files matching the included macOS adapter. The available SDK version follows its compiled dependency declaration."};
  return {...section,id:Source.managerId,sections:[section]};
}
async function installRuntime(context={}){
  const requested=context.version&&context.version!=="auto"?context.version:normalizeSettings(context.settings?.runtimes?.[Source.managerId]).defaultVersion;
  if(requested&&requested!==Source.version)throw Error("The selected Intel SDK version does not match the included XeSS adapter.");
  const selected=provider(context);if(!selected)throw Error("The selected graphics package does not include the XeSS adapter.");
  const installed=Library.listInstalled(context.userDataDir)[0],bytes=missingBytes(installed,selected);
  if(bytes&&!await downloadApproved(context,{managerId:Source.managerId,version:Source.version,label:versionLabel,
    message:"Install Intel XeSS runtime files?",detail:selected.generation?"Includes super resolution, frame generation and the required XeLL companion.":"Includes the original super-resolution runtime.",
    downloadBytes:bytes,requiresDownload:true,kind:"tool",sourceUrl:Source.sourceUrl,confirmLabel:"Install"}))return null;
  // The confirmation above authorizes the component downloads.
  const options={...context,confirmRuntimeInstall:approveDownloads};
  const sr=await Library.install({...options,operation:"superresolution"});if(!sr)return null;
  if(selected.generation){const fg=await Library.install({...options,operation:"interpolate"});if(!fg)return null;}
  return Library.listInstalled(context.userDataDir)[0];
}
module.exports={id:Source.managerId,label:"XeSS",distributionRequired:false,
  delivery:{included:"none",catalog:"declared",sourceBuild:false},
  ui:{groupId:"graphics",tabLabel:"Graphics",sectionLabel:"XeSS",order:0,memberOrder:6,management:"managed"},
  normalizeSettings,getState,installRuntime,coordinateImportRuntime:Library.importRuntime,importRuntime:Library.importRuntime,uninstallRuntime:Library.remove,
  performSetupAction:context=>{if(context.setupActionId==="download")return installRuntime(context);if(context.setupActionId==="downloadFrameGeneration")return Library.install({...context,operation:"interpolate"});throw Error("Choose an available XeSS runtime action.");},
  refreshCatalog:async context=>getState(context).catalog,
  applySettingsUpdate:(action,payload,settings)=>action==="setDefault"?normalizeSettings({defaultVersion:payload?.version}):normalizeSettings(settings),
  updateSettingsAfterInstall:settings=>normalizeSettings(settings),
  updateSettingsAfterUninstall:(settings,payload)=>normalizeSettings(settings).defaultVersion===payload?.version?normalizeSettings():normalizeSettings(settings),core:Library};
