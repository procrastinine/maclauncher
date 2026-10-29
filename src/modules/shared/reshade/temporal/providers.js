// Shared native provider discovery and preparation. Frame-source eligibility is
// evaluated separately from algorithm installation and shader-profile choice.
const groups=Object.freeze([
  {path:"./fsr",methods:["fsr2","fsr3"],environment:["RESHADE_FSR2_LIBRARY","RESHADE_FSR3_LIBRARY","RESHADE_FSR_SHADER_DIRECTORY"]},
  {path:"./fsr4",methods:["fsr4"],environment:["RESHADE_FSR4_LIBRARY","FSR4_ROOT","FSR4_BUILD_DIR"]},
  {path:"./asr",methods:["asr"],environment:["RESHADE_ASR_LIBRARY","RESHADE_ASR_SHADER_DIRECTORY"]},
  {path:"./sgsr2",methods:["sgsr2"],environment:["RESHADE_SGSR2_LIBRARY","RESHADE_SGSR2_SHADER_DIRECTORY"]}
]);
function resolve(root,options={},methods=[]){
  const result=[];
  for(const group of groups){
    const wanted=group.methods.filter(method=>methods.includes(method));if(!wanted.length)continue;
    try{const api=require(group.path),installed=api.resolve(root,options);if(installed)result.push({group,api,installed,methods:wanted.filter(method=>!installed.methods||installed.methods.includes(method))});}catch{}
  }
  return result.filter(value=>value.methods.length);
}
function prepare(root,options,methods){return Object.assign({},...resolve(root,options,methods).map(({api})=>api.prepare(root,options)));}
const environmentKeys=new Set(groups.flatMap(group=>group.environment));
function bindings(environment){
  const values=[...environmentKeys].filter(key=>environment[key]).map(key=>({key,path:environment[key],type:key.endsWith("_LIBRARY")?"file":"directory"}));
  return values.filter((value,index)=>!values.slice(0,index).some(other=>other.type===value.type&&other.path===value.path)&&
    !(value.type==="directory"&&values.some(other=>other!==value&&other.type==="directory"&&value.path.startsWith(other.path+require("node:path").sep))));
}
function prefixes(methods){return groups.filter(group=>group.methods.some(method=>methods.includes(method))).map(group=>"temporal/"+group.path.slice(2)+"/");}
// Reserve fixed paths declared by the already-admitted processor manifest.
// Optional provider discovery, checksums, loading and GPU setup wait for use.
function reserve(root,options,methods,files=[]){
  const path=require("node:path"),declared=new Set(files.map(row=>row.path));
  const providers={},environment={};
  for(const group of groups){
    const relative="temporal/"+group.path.slice(2),directory=path.join(root,relative);
    const available=group.methods.filter(method=>methods.includes(method)&&declared.has(relative+"/libmaclauncher-"+method+".dylib"));
    if(!available.length)continue;
    for(const method of available)providers[method]={library:path.join(directory,"libmaclauncher-"+method+".dylib"),directory};
    for(const key of group.environment){
      const method=/^RESHADE_(.+)_LIBRARY$/.exec(key)?.[1].toLowerCase();
      const value=method?providers[method]?.library:key==="FSR4_BUILD_DIR"?path.join(directory,"build"):directory;
      if(value)environment[key]=value;
    }
  }
  return {providers,environment};
}
module.exports={resolve,prepare,reserve,prefixes,bindings,isEnvironmentKey:key=>environmentKeys.has(key)};
