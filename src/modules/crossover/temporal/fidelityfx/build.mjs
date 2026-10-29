// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),here=import.meta.dirname,source=JSON.parse(fs.readFileSync(path.join(here,'source.json')));
const args=Object.fromEntries(process.argv.slice(2).reduce((rows,value,index,all)=>index%2?rows:[...rows,[value.replace(/^--/,''),all[index+1]]],[]));
if(!['sdk-source','vulkan-source','compiler','out'].every(key=>args[key]))throw Error('Use --sdk-source SDK --vulkan-source SDL --compiler MINGW_CLANG++ --out DIRECTORY [--reference ORIGINAL_DLL]');
const sdk=fs.realpathSync(args['sdk-source']),vulkan=fs.realpathSync(args['vulkan-source']),out=path.resolve(args.out),compiler=path.resolve(args.compiler),backend=args.backend||'vk';
fs.accessSync(compiler,fs.constants.X_OK);
if(!source.libraries[backend])throw Error('Choose vk or dx12.');
const git=(directory,...parameters)=>execFileSync('git',['-C',directory,...parameters],{env:{...process.env,GIT_NO_LAZY_FETCH:'1'},maxBuffer:32*1024*1024});
for(const [directory,pin]of[[sdk,source.sdk],[vulkan,source.vulkan]])if(git(directory,'rev-parse','HEAD').toString().trim()!==pin.revision)throw Error('The source commit does not match '+pin.repository);
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(out,{recursive:true});const inputs=path.join(out,'inputs');fs.mkdirSync(inputs,{recursive:true});
const originalInputs={};
for(const relative of source.sdk.headers){const target=path.join(inputs,relative.slice('ffx-api/include/'.length));fs.mkdirSync(path.dirname(target),{recursive:true});const bytes=git(sdk,'show',source.sdk.revision+':'+relative);fs.writeFileSync(target,bytes);originalInputs[relative]=hash(target);}
for(const relative of source.vulkan.headers){const target=path.join(inputs,'vulkan',relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,git(vulkan,'show',source.vulkan.revision+':'+source.vulkan.directory+'/'+relative));originalInputs['vulkan/'+relative]=hash(target);}
const originalLibrary=path.join(out,source.original[backend]);
const declaredReference=source.sdk.referenceLibraries[backend],sdkReference=git(sdk,'show',source.sdk.revision+':'+declaredReference.path);
if(crypto.createHash('sha256').update(sdkReference).digest('hex')!==declaredReference.sha256)throw Error('The pinned SDK original library differs from its declared digest.');
let reference,referenceSource;
if(args.reference)reference=fs.realpathSync(args.reference);
else{
 fs.writeFileSync(originalLibrary,sdkReference);reference=originalLibrary;
}
if(hash(reference)===declaredReference.sha256)referenceSource={repository:source.sdk.repository,revision:source.sdk.revision,path:declaredReference.path,sha256:declaredReference.sha256};
const expected=new Set(source.exports),exports=require('../streamline/pe-exports').inspect(reference);
if(!Array.isArray(exports)||exports.length!==expected.size||exports.some(row=>!expected.has(row.name)))throw Error('The original library does not match the exact five-export FidelityFX API profile. Preserve its original route.');
if(path.resolve(reference)!==originalLibrary)fs.copyFileSync(reference,originalLibrary);
if(hash(originalLibrary)!==hash(reference))throw Error('The original library copy differs from its reference.');
const referenceVersion=require('../../../shared/runtime/pe-version').readPeVersion(originalLibrary);
if(referenceSource&&referenceVersion?.fileVersion!==source.sdk.referenceFileVersion)throw Error('The pinned original library version differs from its source profile.');
if(!source.version.startsWith(source.sdk.apiVersion+'-')||!referenceVersion)throw Error('The adapter needs an authoritative package and original DLL version.');
const hooks=fs.readFileSync(path.join(inputs,'ffx_api/ffx_api.h'),'utf8');
for(const name of expected)if(!new RegExp('FFX_API_ENTRY\\s+ffxReturnCode_t\\s+'+name+'\\s*\\(').test(hooks))throw Error('The pinned FidelityFX export declaration changed.');
fs.writeFileSync(path.join(out,'profile.hpp'),'#pragma once\nconstexpr const wchar_t*maclauncherOriginalLibrary=L'+JSON.stringify(source.original[backend])+';\n');
const compiledExports=[...exports,{name:'MacLauncherFFXObservationAPI1',ordinal:Math.max(...exports.map(row=>row.ordinal))+1}];
fs.writeFileSync(path.join(out,'exports.def'),'LIBRARY '+source.libraries[backend].replace(/\.dll$/,'')+'\nEXPORTS\n'+compiledExports.map(row=>row.name+' @'+row.ordinal).join('\n')+'\n');
const library=path.join(out,source.libraries[backend]),repository=path.resolve(here,'../../../../..');
execFileSync(compiler,['-std=c++17','-O2','-shared','-static','-Wl,--exclude-all-symbols','-Wl,--no-insert-timestamp',
 '-ffile-prefix-map='+repository+'=MacLauncher','-ffile-prefix-map='+out+'=FidelityFXBuild','-I'+inputs,'-I'+out,path.join(here,'proxy.cpp'),path.join(here,'wine-observer.cpp'),path.join(out,'exports.def'),'-lbcrypt','-o',library],{stdio:'inherit'});
const actual=require('../streamline/pe-exports').inspect(library),ordinals=new Map(compiledExports.map(row=>[row.name,row.ordinal]));
if(actual?.length!==compiledExports.length||actual.some(row=>ordinals.get(row.name)!==row.ordinal))throw Error('The compiled FidelityFX exports changed.');
const clang=execFileSync('xcrun',['--find','clang++'],{encoding:'utf8'}).trim(),macSDK=execFileSync('xcrun',['--sdk','macosx','--show-sdk-path'],{encoding:'utf8'}).trim(),objects=[];
for(const architecture of ['arm64','x86_64']){const object=path.join(out,'recorded-source-'+architecture+'.o');execFileSync(clang,['-std=c++17','-O2','-arch',architecture,'-isysroot',macSDK,'-mmacosx-version-min=13.0','-fdeclspec','-Wno-ignored-attributes',
 '-ffile-prefix-map='+repository+'=MacLauncher','-ffile-prefix-map='+out+'=FidelityFXBuild','-I'+inputs,'-I'+path.resolve(here,'../../../shared/vulkan/native'),'-c',path.join(here,'recorded-source.cpp'),'-o',object],{stdio:'inherit'});objects.push(object);}
const producer=path.join(out,'libffx-vulkan-scene-source.a');execFileSync('libtool',['-static','-o',producer,...objects],{stdio:'inherit'});
let license;for(const file of ['LICENSE.txt','LICENSE.md','LICENSE']){try{license=git(sdk,'show',source.sdk.revision+':'+file);break;}catch{}}
if(!license)throw Error('The original FidelityFX license is unavailable.');fs.writeFileSync(path.join(out,'FidelityFX-SDK-LICENSE.txt'),license);
fs.copyFileSync(path.join(here,source.vulkan.licenseFile),path.join(out,'Vulkan-Headers-Apache-2.0.txt'));
fs.copyFileSync(path.resolve(here,'../../../../../LICENSE'),path.join(out,'MacLauncher-MIT.txt'));
// The Vulkan headers also retain their original copyright notices in inputs/.
const owned=['source.json','Apache-2.0.txt','capture.hpp','observation.h','proxy.cpp','wine-observer.hpp','wine-observer.cpp','scalar-mapping.hpp','native-source.h','recorded-source.hpp','recorded-source.cpp','index.js','build.mjs'];
const metadata={schema:1,version:source.version,profile:source.profile,backend,library:source.libraries[backend],sha256:hash(library),exports:actual,
 sources:source,originalInputs,sourceExports:exports,observationAPI:1,owned:Object.fromEntries(owned.map(file=>[file,hash(path.join(here,file))])),
 dependencies:{...Object.fromEntries(['vulkan/native/scene-interop.h','reshade/native/vulkan-scene.h','reshade/temporal/frame.h','reshade/temporal/scene-aovs.h','reshade/temporal/scene-matrices.h','reshade/native/image-color.h'].map(file=>[file,hash(path.resolve(here,'../../../shared',file))])),
  'crossover/temporal/vulkan/scene-request.h':hash(path.resolve(here,'../vulkan/scene-request.h'))},
 referenceSha256:hash(reference),referenceFileVersion:referenceVersion.fileVersion,...(referenceSource?{referenceSource}:{}),originalLibrary:source.original[backend],
 nativeProducer:{library:path.basename(producer),sha256:hash(producer),recordedSceneAPI:1,originalOutputRetained:true},
 execution:{originalApiForwarding:true,originalGpuWorkRetained:true,nativeVulkanSource:1,wineVulkanObserver:1,wineVulkanContext:1,wineVulkanInterop:false},
 unavailable:['matching-wine-vulkan-native-handle-and-recording-thunk']};
fs.writeFileSync(path.join(out,'provider.json'),JSON.stringify(metadata,null,2)+'\n');
// Runtime packages select binary and notice files only. Compiler inputs and
// the native source archive remain producer outputs outside that selection.
const runtimeFiles=[source.libraries[backend],source.original[backend],'FidelityFX-SDK-LICENSE.txt','Vulkan-Headers-Apache-2.0.txt','MacLauncher-MIT.txt'];
const files=runtimeFiles.map(file=>{const target=path.join(out,file),binary=file.endsWith('.dll');fs.chmodSync(target,binary?0o755:0o644);return{
 path:file,size:fs.statSync(target).size,mode:binary?0o755:0o644,sha256:hash(target),...(binary?{format:'pe',architectures:['x86_64']}:{})};});
const notices=[{name:'FidelityFX SDK',license:source.sdk.license,sourceUrl:source.sdk.repository,path:'FidelityFX-SDK-LICENSE.txt'},
 {name:'Vulkan headers',license:source.vulkan.license,sourceUrl:source.vulkan.repository,path:'Vulkan-Headers-Apache-2.0.txt'},
 {name:'MacLauncher',license:'MIT',sourceUrl:'https://github.com/procrastinine/maclauncher',path:'MacLauncher-MIT.txt'}];
const provider=Object.fromEntries(['schema','version','profile','backend','library','sha256','exports','sourceExports','observationAPI','referenceSha256','referenceFileVersion','originalLibrary','execution'].map(key=>[key,metadata[key]]));
const manifest={schemaVersion:1,managerId:source.id,version:source.version,platform:'darwin',arch:'x64',minimumMacOS:source.minimumMacOS,
 executableRelative:source.libraries[backend],provider,files,notices,dependencies:[]};
const payload=path.join(out,'payload');fs.mkdirSync(payload,{recursive:true});
for(const file of files){const target=path.join(payload,file.path);fs.copyFileSync(path.join(out,file.path),target);fs.chmodSync(target,file.mode);}
// The game-library adapter reads this descriptor from its installed payload.
// Source/build correspondence stays in the separate producer descriptor.
const providerFile=path.join(payload,'provider.json');fs.writeFileSync(providerFile,JSON.stringify(provider,null,2)+'\n');fs.chmodSync(providerFile,0o644);
files.push({path:'provider.json',size:fs.statSync(providerFile).size,mode:0o644,sha256:hash(providerFile)});
const manifestFile=path.join(payload,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');fs.chmodSync(manifestFile,0o644);
const declaration={id:source.id,version:source.version,arch:'x64',launcherArchitectures:['arm64','x64'],minimumMacOS:source.minimumMacOS,
 sourceRelative:null,sourceSha256:hash(path.join(here,'source.json')),directoryRelative:[source.id,source.version,'x64'].join('/'),
 manifestRelative:'manifest.json',manifestSha256:hash(manifestFile),files:[...files,{path:'manifest.json',size:fs.statSync(manifestFile).size,mode:0o644,sha256:hash(manifestFile)}],notices};
fs.writeFileSync(path.join(out,'runtime-package.json'),JSON.stringify(declaration,null,2)+'\n');
console.log(JSON.stringify({library,sha256:metadata.sha256,exports:actual.length,nativeProducer:producer,wineVulkanInterop:false}));
