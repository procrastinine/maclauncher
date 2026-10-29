import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import Content from "./runtime-content.cjs";
const hash=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const safe=name=>typeof name==="string"&&!path.isAbsolute(name)&&!name.split(/[\\/]/).some(part=>!part||part==="."||part==="..");
export function stageTemporalProvider({name,directory,upstream,ownedRoot}){
  if(!["asr","sgsr2"].includes(name))throw Error("Choose a registered temporal provider.");
  const spec=JSON.parse(fs.readFileSync(path.join(ownedRoot,"source.json"),"utf8")),metadata=JSON.parse(fs.readFileSync(path.join(directory,"provider.json"),"utf8"));
  const library=`libmaclauncher-${name}.dylib`;
  if(metadata.providerABI!==1||metadata.complete!==true||metadata.methods?.join()!==name||metadata.architectures?.join()!=="arm64,x86_64"||metadata.minimumMacOS!==spec.minimumMacOS||metadata.resourcePreparation!==1||metadata.source?.repository!==spec.repository||metadata.source?.commit!==spec.commit||metadata.libraries?.join()!==library||!Array.isArray(metadata.files)||metadata.files.length>8192||!metadata.owned)throw Error("A complete compatible native temporal provider is required: "+name);
  const files=new Map();
  for(const row of metadata.files){
    if(!safe(row.path)||Content.excludedReason(row.path)||files.has(row.path)||!Number.isSafeInteger(row.size)||row.size<1||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error("Invalid temporal provider inventory: "+name);
    const file=path.join(directory,row.path),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==row.size||hash(file)!==row.sha256)throw Error("Temporal provider resource changed: "+row.path);
    files.set(row.path,file);
  }
  if(!files.has(library)||![...files.keys()].some(file=>file.startsWith(name+"/")&&file.endsWith(".metal"))||![...files.keys()].some(file=>file.startsWith(name+"/")&&file.endsWith(".json")))throw Error("Temporal shader and library resources are incomplete: "+name);
  const owned=new Map();
  for(const required of ["source.json","build.mjs","backend.mm","descriptor.js","../frame.h"])if(!Object.hasOwn(metadata.owned,required))throw Error("Missing temporal provider build input: "+required);
  for(const [relative,expected] of Object.entries(metadata.owned)){
    if(!safe(relative)&&!['../frame.h','../command-order.hpp','../../shaderc-offline.cpp'].includes(relative)||!/^[a-f0-9]{64}$/.test(expected))throw Error("Invalid owned temporal build input.");
    const file=path.resolve(ownedRoot,relative),target=path.posix.normalize(`maclauncher/temporal/${name}/${relative}`);
    if(!target.startsWith("maclauncher/")||!fs.lstatSync(file).isFile()||hash(file)!==expected)throw Error("Temporal provider source changed: "+relative);
    owned.set(target,file);
  }
  if(!upstream)throw Error("Supply the declared source checkout for the optional "+name+" provider.");
  const git=args=>execFileSync("git",["-C",upstream,...args],{encoding:"utf8"}).trim();
  const canonical=url=>url.replace(/\.git$/,"").replace(/\/$/,"");
  if(git(["rev-parse","HEAD"])!==spec.commit||canonical(git(["remote","get-url","origin"]))!==canonical(spec.repository))throw Error("Temporal provider checkout differs from its declared public origin or exact commit.");
  git(["diff","--exit-code","--ignore-submodules=all","HEAD","--"]);
  if(!Array.isArray(spec.sourceScope)||!spec.sourceScope.length||spec.sourceScope.some(value=>!safe(value)))throw Error("The temporal provider source scope is undeclared.");
  const notices=metadata.notices;
  if(!Array.isArray(notices)||!notices.length||notices.some(row=>!files.has(row.path)||typeof row.name!=="string"||typeof row.license!=="string"||!/^https:\/\//.test(row.sourceUrl||"")))throw Error("Temporal provider notices are incomplete.");
  return {files:new Map([...files].map(([relative,file])=>[`temporal/${name}/${relative}`,file]).concat([[`temporal/${name}/provider.json`,path.join(directory,"provider.json")]])),owned,
    source:{directory:upstream,relative:"third_party/"+name,commit:spec.commit,scope:spec.sourceScope},pin:` ${spec.commit} third_party/${name}`,
    notices:notices.map(row=>({...row,path:`temporal/${name}/${row.path}`}))};
}
