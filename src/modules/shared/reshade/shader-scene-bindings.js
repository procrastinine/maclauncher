const {SCENE_SHADER_INPUTS,sceneInputRequirements}=require("../effects/operation-contracts.mjs");
const ROLES=SCENE_SHADER_INPUTS,MAX_BINDINGS=128;
const resource=/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/;
function validate(value){
  if(value===undefined)return {};
  if(!value||typeof value!=="object"||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error("Choose valid named scene input bindings.");
  const entries=Object.entries(value);
  if(entries.length>MAX_BINDINGS)throw Error("A shader can declare at most 128 scene input resources.");
  for(const [name,role]of entries)if(name.length>512||!resource.test(name)||["__proto__","constructor","prototype"].includes(name)||!ROLES.includes(role))throw Error("A scene input requires a shader resource identifier and a canonical role.");
  return Object.fromEntries(entries);
}
function parse(text){
  const bindings=new Map();
  for(const line of text.split(/\r?\n/)){
    if(!/^\s*\/\/!\s*SCENE_INPUT\b/.test(line))continue;
    const match=/^\s*\/\/!\s*SCENE_INPUT\s+(\S+)\s+(\S+)\s*$/.exec(line);
    if(!match||match[1].length>512||!resource.test(match[1])||["__proto__","constructor","prototype"].includes(match[1]))throw Error("A scene input requires a shader resource identifier and a canonical role.");
    const [,name,role]=match;
    if(!ROLES.includes(role))throw Error("Unknown scene input role: "+role+".");
    if(bindings.has(name)&&bindings.get(name)!==role)throw Error("A shader resource cannot bind different scene input roles: "+name+".");
    bindings.set(name,role);if(bindings.size>MAX_BINDINGS)throw Error("A shader can declare at most 128 scene input resources.");
  }
  return Object.fromEntries(bindings);
}
function apply(text,traits){
  let sceneHistory,preservesCoordinates;
  for(const line of text.split(/\r?\n/)){
    if(/^\s*\/\/!\s*SCENE_HISTORY\b/.test(line)){
      if(!/^\s*\/\/!\s*SCENE_HISTORY\s+real\s*$/.test(line))throw Error("A shader history declaration must select real source frames.");
      sceneHistory="real";
    }
    if(/^\s*\/\/!\s*SCENE_COORDINATES\b/.test(line)){
      if(!/^\s*\/\/!\s*SCENE_COORDINATES\s+preserve\s*$/.test(line))throw Error("A shader coordinate declaration must preserve the source image mapping.");
      preservesCoordinates=true;
    }
  }
  const declared={...(sceneHistory?{sceneHistory}:{}),...(preservesCoordinates?{preservesCoordinates}:{})};
  const sceneBindings=parse(text);if(!Object.keys(sceneBindings).length)return {...traits,...declared};
  const sceneInputs=[...new Set([...(traits.sceneInputs||[]),...ROLES.filter(role=>Object.values(sceneBindings).includes(role))])];
  return {...traits,sceneBindings,sceneInputs,...declared};
}
function requirements(bindings){return sceneInputRequirements(Object.values(validate(bindings)));}
module.exports={ROLES,MAX_BINDINGS,parse,validate,apply,requirements};
