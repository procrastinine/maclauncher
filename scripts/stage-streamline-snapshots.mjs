import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import PE from "../src/modules/crossover/temporal/streamline/pe-exports.js";

const inputs=Object.freeze({
  streamline:["build.mjs","source.json","proxy.cpp","camera.hpp","resources.hpp","snapshots.hpp","snapshot-budget.hpp","pe-exports.js",
    "../dxmt/camera-transport.hpp","../dxmt/streamline-transport.hpp","../dxmt/streamline-snapshot.hpp",
    "../../../shared/reshade/temporal/camera.h","../../../shared/reshade/temporal/frame.h",
    "../../../shared/reshade/native/image-color.h","../../../shared/reshade/native/image-budget.hpp"],
  dxmt:["build.mjs","source.json","patch.mjs","snapshot-overlay.mjs","camera-transport.hpp","streamline-transport.hpp","streamline-snapshot.hpp","streamline-native.h","unix-forwarder.c"]
});
const origins=Object.freeze({streamline:"https://github.com/NVIDIA-RTX/Streamline",dxmt:"https://github.com/3Shain/dxmt"});
const digest=file=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function stageStreamlineSnapshots({name,directory,metadata,recipeRoot}){
  if(metadata.resourceSnapshotAPI===undefined)return null;
  if(!Object.hasOwn(inputs,name)||metadata.resourceSnapshotAPI!==1||metadata.source?.url!==origins[name]||!/^[a-f0-9]{40}$/.test(metadata.source?.revision||""))throw Error("The tagged GPU snapshot source contract is invalid.");
  const expected=inputs[name],sources=metadata.sources;
  if(!sources||Object.keys(sources).sort().join()!==[...expected].sort().join())throw Error("The tagged GPU snapshot source closure is incomplete.");
  const owned=new Map(),root=path.join(recipeRoot,name);
  for(const relative of expected){
    const file=path.resolve(root,relative),stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||!/^[a-f0-9]{64}$/.test(sources[relative])||digest(file)!==sources[relative])throw Error("The tagged GPU snapshot build input changed: "+relative);
    owned.set(path.posix.normalize(`maclauncher/crossover/temporal/${name}/${relative}`),file);
  }
  if(name==="streamline"){
    if(JSON.stringify(metadata.resourceSnapshotProfiles)!=='["d3d11-v2"]')throw Error("The Streamline tag-time snapshot profile is invalid.");
    const actual=PE.inspect(path.join(directory,metadata.library));
    if(!actual||JSON.stringify(actual)!==JSON.stringify(metadata.exports)||!["slSetTag","slSetTagForFrame"].every(name=>actual.some(row=>row.name===name)))throw Error("The original Streamline snapshot export table changed.");
  }else{
    const actual=PE.inspect(path.join(directory,"x86_64-windows/nvngx.dll"));
    for(const symbol of ["MacLauncherSetStreamlineResourcesV2","MacLauncherClearStreamlineResourcesV2","MacLauncherStreamlineTagSnapshotsAPI"])
      if(!actual?.some(row=>row.name===symbol))throw Error("The DXMT tag-time GPU snapshot API is missing: "+symbol);
  }
  return {owned,pin:` ${metadata.source.revision} third_party/${name}-snapshot`};
}
