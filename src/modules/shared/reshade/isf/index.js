const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Writable=require("../../writable-input"),Bundle=require("../shader-bundle");
const hash=bytes=>crypto.createHash("sha256").update(bytes).digest("hex");
const format="isf",entryFile="effect.isf",maximum=8*1024*1024;
function input(file){if(!path.isAbsolute(file||"")||! /\.(?:fs|isf)$/i.test(file)||/[\x00-\x1f]/.test(file))throw Error("Choose an ISF .fs or .isf shader.");const source=fs.realpathSync(file),stat=fs.statSync(source);if(!stat.isFile()||stat.size>maximum)throw Error("The ISF shader must be a file of at most 8 MiB.");return source;}
function parse(text){
  const block=/\/\*\s*(\{[\s\S]*?\})\s*\*\//.exec(text);if(!block)throw Error("The ISF JSON declaration is missing.");let declaration;try{declaration=JSON.parse(block[1]);}catch{throw Error("The ISF JSON declaration is invalid.");}
  if(!declaration||typeof declaration!=="object"||Array.isArray(declaration)||declaration.INPUTS!==undefined&&!Array.isArray(declaration.INPUTS)||(declaration.INPUTS?.length||0)>512)throw Error("The ISF input declarations are invalid.");
  const parameters=[],requirements=[],names=new Set();
  for(const item of declaration.INPUTS||[]){
    if(!item||typeof item.NAME!=="string"||! /^[A-Za-z_]\w{0,127}$/.test(item.NAME)||["__proto__","constructor","prototype"].includes(item.NAME)||names.has(item.NAME))throw Error("ISF input names must be unique shader identifiers.");names.add(item.NAME);
    if(["image","audio","audioFFT","cube"].includes(item.TYPE)){if(item.TYPE!=="image"||item.NAME!=="inputImage")requirements.push({name:item.NAME,type:item.TYPE});continue;}
    const sizes={event:1,bool:1,long:1,float:1,point2D:2,color:4},size=sizes[item.TYPE];if(!size)throw Error("The ISF input type is unsupported: "+String(item.TYPE));
    const fallback=size===4?[0,0,0,1]:Array(size).fill(0),raw=item.DEFAULT===undefined?fallback:Array.isArray(item.DEFAULT)?item.DEFAULT:[item.DEFAULT],defaults=raw.map(value=>typeof value==="boolean"?Number(value):value);
    if(defaults.length!==size||defaults.some(value=>!Number.isFinite(value)))throw Error("The ISF input default is invalid.");
    const parameter={name:item.NAME,label:typeof item.LABEL==="string"?item.LABEL:item.NAME,type:["event","bool"].includes(item.TYPE)?"bool":item.TYPE==="long"?"int":"float",default:defaults,rows:1,columns:size};
    for(const [key,name]of [["MIN","min"],["MAX","max"]])if(item[key]!==undefined){const values=(Array.isArray(item[key])?item[key]:[item[key]]).map(value=>typeof value==="boolean"&&["event","bool"].includes(item.TYPE)?Number(value):value);if(values.some(value=>!Number.isFinite(value)))throw Error("The ISF parameter range is invalid.");parameter[name]=key==="MIN"?Math.min(...values):Math.max(...values);}
    if(item.TYPE==="color"){parameter.min??=0;parameter.max??=1;parameter.uiType="color";}
    if(item.VALUES!==undefined){if(item.TYPE!=="long"||!Array.isArray(item.VALUES)||!Array.isArray(item.LABELS)||item.VALUES.length!==item.LABELS.length||item.VALUES.length>4096||item.VALUES.some(value=>!Number.isSafeInteger(value))||item.LABELS.some(value=>typeof value!=="string"))throw Error("The ISF choices are invalid.");parameter.options=item.VALUES.map((value,index)=>({value,label:item.LABELS[index]}));}
    parameters.push(parameter);
  }
  if(declaration.PASSES!==undefined&&(!Array.isArray(declaration.PASSES)||declaration.PASSES.length>128))throw Error("The ISF pass declarations are invalid.");
  const inputPolicy=require("../shader-input-policy").declared(text)||(declaration.PASSES?.at(-1)?.FLOAT===true?"source":"srgb-sdr");
  return {block,declaration,metadata:{schema:1,format,parameters,requirements,rgbCompatible:true,inputPolicy,traits:{category:"effects",neural:false,rgbCompatible:true,inputPlanes:["rgb"],geometryKnown:true,requestedOutputExtent:true,outputExtentEditable:true,inputPolicy,domains:["RGB"],preservesCoordinates:false,inputDomain:"RGB",outputDomain:"RGB",...(requirements.length?{auxiliaryInputs:requirements}:{})}}};
}
function metadata(value){if(value?.format!==format||!Array.isArray(value.requirements))throw Error("The ISF shader metadata is invalid.");return require("../libplacebo").metadata(value);}
const provider={id:format,entryFile,label:"ISF",parseMetadata:metadata};
async function inspect(file,{signal}={}){signal?.throwIfAborted();return metadata(parse(await fs.promises.readFile(input(file),"utf8")).metadata);}
async function prepare(file,{userDataDir,signal}={}){
  file=input(file);signal?.throwIfAborted();const base=path.join(userDataDir,"graphics/shaders/isf");Writable.assertOwnDirectory(userDataDir,base);
  const temporary=path.join(base,".prepare-"+crypto.randomUUID());await fs.promises.mkdir(temporary);
  try{
    const text=await fs.promises.readFile(file,"utf8"),parsed=parse(text),declaration=structuredClone(parsed.declaration),files=[];let bytes=0;
    const add=async(name,contents)=>{signal?.throwIfAborted();if((bytes+=contents.length)>Bundle.LIMITS.bytes||files.length>=Bundle.LIMITS.files)throw Error("The ISF shader resources exceed their size limit.");const destination=path.join(temporary,name);await fs.promises.mkdir(path.dirname(destination),{recursive:true});await fs.promises.writeFile(destination,contents,{mode:0o600});files.push({path:name,size:contents.length,sha256:hash(contents)});};
    if(declaration.IMPORTED!==undefined){
      if(!declaration.IMPORTED||typeof declaration.IMPORTED!=="object"||Array.isArray(declaration.IMPORTED)||Object.keys(declaration.IMPORTED).length>128)throw Error("The ISF imported images must be named declarations.");
      for(const [name,item]of Object.entries(declaration.IMPORTED)){
        if(!/^[A-Za-z_]\w{0,127}$/.test(name)||!item||typeof item.PATH!=="string"||path.isAbsolute(item.PATH)||/[\x00-\x1f]/.test(item.PATH))throw Error("The ISF imported image path is invalid.");
        const asset=fs.realpathSync(path.resolve(path.dirname(file),item.PATH)),parent=fs.realpathSync(path.dirname(file));if(!asset.startsWith(parent+path.sep))throw Error("ISF imported images must be inside the shader folder.");
        const stat=fs.statSync(asset);if(!stat.isFile()||stat.size>64*1024*1024)throw Error("The ISF imported image exceeds its size limit.");const relative="assets/"+files.length+path.extname(asset).toLowerCase();await add(relative,await fs.promises.readFile(asset));item.PATH=relative;
      }
    }
    const start=parsed.block.index,end=start+parsed.block[0].length;await add(entryFile,Buffer.from(text.slice(0,start)+"/*"+JSON.stringify(declaration)+"*/"+text.slice(end)));
    const vertex=file.replace(/\.(?:fs|isf)$/i,".vs");if(fs.existsSync(vertex)){const canonical=fs.realpathSync(vertex);if(!canonical.startsWith(path.dirname(file)+path.sep))throw Error("The ISF vertex shader must remain in the shader folder.");const stat=fs.statSync(canonical);if(!stat.isFile()||stat.size>maximum)throw Error("The ISF vertex shader exceeds its size limit.");await add("effect.vs",await fs.promises.readFile(canonical));}
    await fs.promises.writeFile(path.join(temporary,"metadata.json"),JSON.stringify({...parsed.metadata,files}),{mode:0o600});
    const verified=Bundle.verify(temporary,provider),destination=path.join(base,verified.revision);
    if(fs.existsSync(destination))Bundle.verify(destination,provider);else try{await fs.promises.rename(temporary,destination);}catch(error){if(!["EEXIST","ENOTEMPTY"].includes(error.code))throw error;Bundle.verify(destination,provider);}
    return {...verified,directory:destination,effect:path.join(destination,entryFile)};
  }finally{await fs.promises.rm(temporary,{recursive:true,force:true});}
}
module.exports={format,input,parse,metadata,inspect,prepare,verifyBundle:directory=>Bundle.verify(directory,provider)};
