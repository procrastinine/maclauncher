import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";
import {isolateCompiler} from "./isolate-compiler.mjs";
import {SCENE_SHADER_INPUTS} from "../../effects/operation-contracts.mjs";
const owned=import.meta.dirname,workspace=path.resolve(owned,"../../../../.."),source=JSON.parse(fs.readFileSync(path.join(owned,"source.json")));
const output=path.resolve(process.argv[2]||"");
if(!process.argv[2]||process.argv.length!==3&&!(process.argv.length===5&&process.argv[3]==="--payload"))throw Error("Choose an ISF build directory and optional --payload <new output>.");
const run=(cmd,args)=>execFileSync(cmd,args,{stdio:"inherit"});
const write=(file,bytes)=>{bytes=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes);if(!fs.existsSync(file)||!fs.readFileSync(file).equals(bytes))fs.writeFileSync(file,bytes);};
for(const entry of source.sources){const root=path.join(workspace,entry.path),actual=execFileSync("git",["-C",root,"rev-parse","HEAD"],{encoding:"utf8"}).trim();if(actual!==entry.commit)throw Error("Initialize the selected ISF source: "+entry.path);execFileSync("git",["-C",root,"diff","--exit-code","HEAD","--"],{stdio:"pipe"});}
const upstream=path.join(workspace,source.sources[0].path),input=path.join(output,"input"),payload=process.argv[4]?path.resolve(process.argv[4]):path.join(output,"payload");
if(fs.existsSync(path.join(payload,"provider.json")))throw Error("Choose a new ISF payload directory; the build cache can be reused.");
fs.mkdirSync(input,{recursive:true});fs.mkdirSync(payload,{recursive:true});
const roots={ISFMSLKit:path.join(upstream,"ISFMSLKit"),VVMetalKit:path.join(upstream,"submodules/VVMetalKit/VVMetalKit"),PINCache:path.join(upstream,"submodules/PINCache/Source"),PINOperation:path.join(upstream,"submodules/PINCache/Carthage/Checkouts/PINOperation/Source"),generator:path.join(upstream,"submodules/ISFGLSLGenerator/libISFGLSLGenerator")};
const names=new Set(),inputs=[];
for(const [name,root]of Object.entries(roots)){
  fs.mkdirSync(path.join(input,name),{recursive:true});
  const directories=name==="generator"?[path.join(root,"include"),path.join(root,"src")]:[root];
  for(const directory of directories)for(const filename of fs.readdirSync(directory).sort()){
    const file=path.join(directory,filename);if(!fs.lstatSync(file).isFile()||! /\.(?:h|hpp|m|mm|cpp|metal)$/.test(filename))continue;
    let bytes=fs.readFileSync(file),text=bytes.toString("utf8");for(const match of text.matchAll(/@(?:interface|protocol)\s+([A-Za-z_]\w*)/g))if(!/^(?:NS|CI|MTL|CG)/.test(match[1]))names.add(match[1]);
    for(const match of text.matchAll(/\b(?:isVV[A-Za-z_]\w*|isfMD5String)\b/g))names.add(match[0]);
    // Library shaders use their own resource bundle rather than the game's.
    if(name==="VVMetalKit"&&/\.(?:m|mm)$/.test(filename))text=text.replace(/\[(?:self\.device|device|n|inDevice) newDefaultLibraryWithBundle:myBundle error:&nsErr\]/g,"MCLISFDefaultLibrary(self.device)");
    if(name==="VVMetalKit"&&filename==="VVMTLPool.m")text=text.replace(/\[_device newTextureWithDescriptor:texDesc\]/g,"MCLISFNewTexture(_device,texDesc)");
    write(path.join(input,name,filename),text);inputs.push({path:path.relative(upstream,file),sha256:crypto.createHash("sha256").update(bytes).digest("hex")});
  }
}
const prefix=["#include <stdint.h>","#ifdef __OBJC__","#import <Metal/Metal.h>","#ifdef __cplusplus","extern \"C\" {","#endif","id<MTLLibrary> MCLISFDefaultLibrary(id<MTLDevice>);","id<MTLTexture> MCLISFNewTexture(id<MTLDevice>,MTLTextureDescriptor*);","#ifdef __cplusplus","}","#endif","#endif",...[...names].sort().map(name=>`#define ${name} MCLGraphics_${name}`)].join("\n")+"\n";write(path.join(input,"prefix.h"),prefix);
for(const file of source.compilerLibraries){
  const library=path.join(input,path.basename(file));write(library,fs.readFileSync(path.join(upstream,file)));
  isolateCompiler(library);
  const include=path.join(upstream,path.dirname(path.dirname(file)),"include");for(const name of fs.readdirSync(include))if(name.endsWith(".hpp"))write(path.join(input,name),fs.readFileSync(path.join(include,name)));
}
run("cmake",["-S",owned,"-B",path.join(output,"cmake"),"-DISF_INPUT="+input,"-DMACFX_INPUT="+path.resolve(owned,"../native"),"-DCMAKE_BUILD_TYPE=Release"]);
run("cmake",["--build",path.join(output,"cmake"),"--parallel","2"]);
fs.copyFileSync(path.join(output,"cmake/libmacfx-isf.dylib"),path.join(payload,source.library));
for(const file of source.compilerLibraries){const filename=path.basename(file);fs.copyFileSync(path.join(input,filename),path.join(payload,filename));}
const shaderRoot=roots.VVMetalKit,air=[];
for(const name of ["CopierMTLScene","SwizzleMTLScene"]){const file=path.join(output,name+".air");run("xcrun",["-sdk","macosx","metal","-std=metal3.0","-mmacosx-version-min=15.0","-I",shaderRoot,"-I",input,"-c",path.join(shaderRoot,name+".metal"),"-o",file]);air.push(file);}
run("xcrun",["-sdk","macosx","metallib",...air,"-o",path.join(payload,"default.metallib")]);
fs.copyFileSync(path.join(upstream,"LICENSE.txt"),path.join(payload,"ISF-LICENSE.txt"));
for(const [name,root]of [["VVMetalKit",path.join(upstream,"submodules/VVMetalKit")],["ISFGLSLGenerator",path.join(upstream,"submodules/ISFGLSLGenerator")],["PINCache",path.join(upstream,"submodules/PINCache")],["PINOperation",path.join(upstream,"submodules/PINCache/Carthage/Checkouts/PINOperation")]]){
  const license=fs.readdirSync(root).find(file=>/^license(?:\.txt|\.md)?$/i.test(file));if(!license)throw Error("The ISF dependency license is missing: "+name);fs.copyFileSync(path.join(root,license),path.join(payload,name+"-LICENSE.txt"));
}
for(const name of [source.library,...source.compilerLibraries.map(file=>path.basename(file))])run("codesign",["--force","--sign","-",path.join(payload,name)]);
const files=fs.readdirSync(payload).filter(name=>name!=="provider.json").sort().map(name=>{const bytes=fs.readFileSync(path.join(payload,name));return {path:name,size:bytes.length,sha256:crypto.createHash("sha256").update(bytes).digest("hex")};});
const ownedInputs=Object.fromEntries(["source.json","build.mjs","isolate-compiler.mjs","../compiler-isolation.mjs","../../effects/operation-contracts.mjs","CMakeLists.txt","provider.mm","index.js"].map(name=>[name,crypto.createHash("sha256").update(fs.readFileSync(path.join(owned,name))).digest("hex")]));
const nativeRoot=path.resolve(owned,"../native"),dependencyText=fs.readFileSync(path.join(output,"cmake/CMakeFiles/macfx-isf.dir/provider.mm.o.d"),"utf8").replace(/\\\r?\n/g," ");
const dependencies=[...dependencyText.matchAll(/(?:\\.|[^\s])+/g)].map(match=>match[0].replace(/\\(.)/g,"$1")).filter(file=>file.startsWith(nativeRoot+path.sep)&&/\.(?:h|hpp)$/.test(file));
const headerInputs=Object.fromEntries([...new Set(dependencies)].sort().map(file=>[path.relative(nativeRoot,file),crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")]));if(!Object.keys(headerInputs).length)throw Error("The ISF provider header closure is missing.");
const exports=execFileSync("nm",["-gj",path.join(payload,source.library)],{encoding:"utf8"}).split(/\r?\n/);
if(!["_rsISFSceneInputsAPI","_rsISFBindSceneInputs"].every(name=>exports.includes(name)))throw Error("The ISF scene input API exports are missing.");
fs.writeFileSync(path.join(payload,"provider.json"),JSON.stringify({...source,sceneInputsAPI:1,sceneInputRoles:SCENE_SHADER_INPUTS.filter(role=>!["viewMatrix","projectionMatrix"].includes(role)),inputs,owned:ownedInputs,headerInputs,files},null,2)+"\n");console.log(JSON.stringify({payload,files:files.length}));
