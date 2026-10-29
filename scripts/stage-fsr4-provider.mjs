import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import Content from "./runtime-content.cjs";
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const safe=name=>typeof name==="string"&&!path.isAbsolute(name)&&!name.split(/[\\/]/).some(part=>!part||part==="."||part==="..");
export function stageFSR4Provider({directory,upstream,ownedRoot}){
  const spec=JSON.parse(fs.readFileSync(path.join(ownedRoot,"source.json"))),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json")));
  if(metadata.providerABI!==1||metadata.complete!==true||metadata.repository!==spec.repository||metadata.library!=="libmaclauncher-fsr4.dylib")throw Error("A complete compatible FSR 4 provider is required.");
  if(!metadata.profilesAPI){
    if(!spec.legacyPayloads?.some(row=>row.commit===metadata.commit&&row.model===metadata.model)||metadata.profile!=="exact-fast")throw Error("The legacy FSR 4 source identity is undeclared.");
    return null;
  }
  if(metadata.profilesAPI!==1||metadata.resourcePreparation!==1||metadata.commit!==spec.commit||metadata.model!==spec.model||
     JSON.stringify(metadata.supportedProfiles)!==JSON.stringify(spec.supportedProfiles)||!Array.isArray(metadata.files)||metadata.files.length>16000||!metadata.owned)throw Error("The FSR 4 profile and resource contracts are incomplete.");
  const files=new Map();
  for(const row of metadata.files){
    if(!safe(row.path)||row.path==="provider.json"||Content.excludedReason(row.path)||files.has(row.path)||!Number.isSafeInteger(row.size)||row.size<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error("Invalid FSR 4 runtime inventory.");
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.size||hash(file)!==row.sha256)throw Error("An FSR 4 runtime input changed: "+row.path);
    files.set(row.path,file);
  }
  for(const required of [metadata.library,"NOTICE.md","third_party/fsr411/initializers.bin","third_party/fsr411/LICENSE","third_party/fsr411/LICENSE.AMD.md","third_party/fsr411/LICENSE.Lite2.txt"])
    if(!files.has(required))throw Error("A required FSR 4 runtime input is missing: "+required);
  const symbols=execFileSync("/usr/bin/nm",["-gU",files.get(metadata.library)],{encoding:"utf8"});
  for(const name of ["rsGetTemporalProvider","rsPrepareTemporalResources","rsTemporalProviderProfiles"])if(!new RegExp("\\b_"+name+"\\b").test(symbols))throw Error("The FSR 4 provider is missing its profile or preparation interface.");
  const owned=new Map();
  for(const required of ["source.json","build.mjs","adapt-runtime.mjs","provider.mm","index.js","NOTICE.md","../frame.h"])if(!Object.hasOwn(metadata.owned,required))throw Error("An FSR 4 build input is undeclared: "+required);
  for(const [relative,expected]of Object.entries(metadata.owned)){
    if((!safe(relative)&&relative!=="../frame.h")||!/^[a-f0-9]{64}$/.test(expected))throw Error("Invalid owned FSR 4 build input.");
    const file=path.resolve(ownedRoot,relative);if(!fs.lstatSync(file).isFile()||hash(file)!==expected)throw Error("An FSR 4 build input changed: "+relative);
    owned.set(path.posix.normalize("maclauncher/temporal/fsr4/"+relative),file);
  }
  const archive=metadata.sourceInputs?.find(row=>row.path==="source-inputs/weights_lossy2.npz");
  if(!archive||metadata.sourceInputs.length!==1||archive.sha256!==spec.lite2.sha256||archive.repository!==spec.lite2.repository||archive.commit!==spec.lite2.commit||archive.sourceUrl!==spec.lite2.url)throw Error("The Lite 2 source archive identity is incomplete.");
  const archiveFile=path.join(path.dirname(directory),archive.path),archiveStat=fs.lstatSync(archiveFile);
  if(!archiveStat.isFile()||archiveStat.isSymbolicLink()||archiveStat.size!==archive.size||hash(archiveFile)!==archive.sha256||hash(files.get("third_party/fsr411/LICENSE.Lite2.txt"))!==spec.lite2.licenseSha256)throw Error("A Lite 2 source or license input changed.");
  owned.set("maclauncher/temporal/fsr4/inputs/weights_lossy2.npz",archiveFile);
  if(!upstream)throw Error("Supply the exact FSR 4 source checkout for this provider.");
  const git=args=>execFileSync("git",["-C",upstream,...args],{encoding:"utf8"}).trim(),canonical=url=>url.replace(/\.git$/,"").replace(/\/$/,"");
  if(git(["rev-parse","HEAD"])!==spec.commit||canonical(git(["remote","get-url","origin"]))!==canonical(spec.repository))throw Error("The FSR 4 checkout differs from its declared public origin or commit.");
  git(["diff","--exit-code","--ignore-submodules=all","HEAD","--"]);
  files.set("provider.json",path.join(directory,"provider.json"));
  return {files:new Map([...files].map(([name,file])=>["temporal/fsr4/"+name,file])),owned,profiles:[...metadata.supportedProfiles],
    source:{directory:upstream,relative:"third_party/fsr4-native-macos",commit:spec.commit},
    pins:[` ${spec.commit} third_party/fsr4-native-macos`,` ${spec.lite2.commit} third_party/fsr4-lite2-weights`,...(spec.sources||[]).map((row,index)=>{if(!/^https:\/\//.test(row.repository||" ")||!/^[a-f0-9]{40}$/.test(row.commit||" "))throw Error("An FSR 4 consumed source pin is incomplete.");return ` ${row.commit} third_party/fsr4-input-${index+1}`;})],
    notices:[{name:"FSR 4 Lite 2 trained weights",license:spec.lite2.license,path:"temporal/fsr4/third_party/fsr411/LICENSE.Lite2.txt",sourceUrl:spec.lite2.repository}]};
}
