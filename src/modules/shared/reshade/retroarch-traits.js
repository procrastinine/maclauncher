// Descriptive preset sizing only. The original librashader parser/compiler
// remains responsible for executable syntax, resources, history and feedback.
const fs=require("node:fs"),path=require("node:path");
const programCache=new Map(),stamp=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":");
const base={category:"effects",neural:false,rgbCompatible:true,inputPlanes:["rgb"],preservesCoordinates:false};
const unknown=()=>({...base,geometryKnown:false,unresolvedGeometry:true,outputExtentEditable:true});
function configuration(text,load,origin){
  const values=new Map();values.origins=new Map();
  for(const line of text.split(/\r?\n/)){
    if(!line.trim()||/^\s*(?:#(?!reference\b)|\/\/)/.test(line))continue;
    const reference=/^\s*#reference\s+"([^"\r\n]+)"\s*(?:#.*)?$/.exec(line);
    if(reference){if(!load)return null;const inherited=load(reference[1]);if(!inherited)return null;for(const pair of inherited){values.set(...pair);values.origins.set(pair[0],inherited.origins?.get(pair[0]));}continue;}
    const match=/^\s*([A-Za-z_]\w*)\s*=\s*(?:"([^"\r\n]*)"|([^#\r\n]*?))\s*(?:#.*)?$/.exec(line);
    if(!match)return null;
    values.set(match[1],(match[2]??match[3]).trim());
    values.origins.set(match[1],origin);
  }
  return values;
}
function geometry(values){
  if(!values)return unknown();
  const count=Number(values.get("shaders"));if(!Number.isInteger(count)||count<1||count>4096)return unknown();
  let extent={x:{domain:"input",factor:1},y:{domain:"input",factor:1}},authoredOutput=false;
  for(let i=0;i<count;i++){
    // The upstream preset parser admits sizing only with a scale type;
    // a scale factor by itself leaves the last pass viewport-sized.
    const declared=["scale_type","scale_type_x","scale_type_y"].some(key=>values.has(key+i));
    if(i===count-1)authoredOutput=declared;
    if(!declared){if(i===count-1)extent={x:{domain:"stage",factor:1},y:{domain:"stage",factor:1}};continue;}
    const next={};
    for(const axis of ["x","y"]){
      // librashader gives the combined value priority over axis overrides.
      const type=values.get(`scale_type${i}`)??values.get(`scale_type_${axis}${i}`)??"source";
      const factor=Number(values.get(`scale${i}`)??values.get(`scale_${axis}${i}`)??1);
      if(!Number.isFinite(factor)||factor<=0)return unknown();
      if(type==="source")next[axis]={domain:extent[axis].domain,factor:extent[axis].factor*factor};
      else if(type==="original")next[axis]={domain:"input",factor};
      else if(type==="viewport")next[axis]={domain:"stage",factor};
      else if(type==="absolute"&&Number.isInteger(factor))next[axis]={domain:"absolute",factor};
      else return unknown();
    }
    extent=next;
  }
  const {x,y}=extent;
  if(x.domain==="stage"&&y.domain==="stage"&&x.factor===1&&y.factor===1)return {...base,geometryKnown:true,requestedOutputExtent:true,outputExtentEditable:true,...(authoredOutput?{authoredResize:true}:{})};
  if(x.domain!=="input"||y.domain!=="input")return {...base,geometryKnown:false,unresolvedGeometry:true,outputExtentEditable:false,...(authoredOutput?{authoredResize:true}:{}),...(x.domain==="stage"||y.domain==="stage"?{displayDependentGeometry:true}:{})};
  const outputScale={x:x.factor,y:y.factor};
  const category=x.factor>=1&&y.factor>=1&&(x.factor>1||y.factor>1)?"upscaling":x.factor<=1&&y.factor<=1&&(x.factor<1||y.factor<1)?"downscaling":"effects";
  return {...base,category,geometryKnown:true,outputScale,outputExtentEditable:false,...(x.factor===1&&y.factor===1?{preservesSize:true}:{})};
}
function inspect(text,format){return format==="slang"?{...base,geometryKnown:true,requestedOutputExtent:true,outputExtentEditable:true}:geometry(configuration(text));}
function analyze(file,text,format){
  const dependencies=[],declarations=[text],active=new Set([file]),tracked=new Set([file]),programs=new Set();let bytes=Buffer.byteLength(text);
  function dependency(candidate){
    let target,stat;try{target=fs.realpathSync(candidate);stat=fs.statSync(target);}catch(error){if(!tracked.has(candidate)){tracked.add(candidate);dependencies.push({file:candidate,stamp:null});}throw error;}
    if(!tracked.has(target)){
      if(dependencies.length>=4096||!stat.isFile()||stat.size>8*1024*1024||(bytes+=stat.size)>256*1024*1024)throw Error("The Slang source metadata exceeds its resource limit.");
      tracked.add(target);dependencies.push({file:target,stamp:stamp(stat)});
    }return {target,stat};
  }
  function program(candidate){
    const {target,stat}=dependency(candidate);if(programs.has(target))return;programs.add(target);
    let facts=programCache.get(target);const identity=stamp(stat);
    if(facts?.identity!==identity){
      const source=fs.readFileSync(target,"utf8");facts={identity,annotations:source.split(/\r?\n/).filter(line=>/^\s*\/\/!?\s*(?:@OUTPUT_RESIZE|INPUT_POLICY|SCENE_INPUT|SCENE_HISTORY|SCENE_COORDINATES)\b/.test(line)).join("\n"),
        includes:[...source.matchAll(/^\s*#\s*include\s*"([^"\r\n]+)"/gm)].map(match=>match[1])};
      if(programCache.size>=4096)programCache.delete(programCache.keys().next().value);programCache.set(target,facts);
    }
    if(facts.annotations)declarations.push(facts.annotations);
    for(const include of facts.includes)program(path.resolve(path.dirname(target),include));
  }
  const read=(parent,name)=>{
    if(dependencies.length>=64)return null;
    const {target,stat}=dependency(path.resolve(path.dirname(parent),name));
    if(active.has(target))return null;
    if(!stat.isFile())return null;
    active.add(target);try{const contents=fs.readFileSync(target,"utf8");declarations.push(contents);return configuration(contents,child=>read(target,child),target);}finally{active.delete(target);}
  };
  try{
    const standalone=/\.slang$/i.test(file),values=standalone?null:configuration(text,name=>read(file,name),file);
    const traits=standalone?inspect(text,"slang"):geometry(values);
    try{
      if(standalone)program(file);
      else if(values)for(let i=0;i<Number(values.get("shaders"));i++){const name=values.get(`shader${i}`);if(name)program(path.resolve(path.dirname(values.origins.get(`shader${i}`)||file),name));}
    }catch(error){traits.sourceInfo=error.message;}
    return {traits,dependencies,declarations:declarations.join("\n")};
  }
  catch{return {traits:unknown(),dependencies,declarations:declarations.join("\n")};}
}
module.exports={inspect,analyze};
