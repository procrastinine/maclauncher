import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {adaptedKosmicSources} from './kosmickrisp-source.mjs';
import {prepareSourceTree,writeChanged} from './source-files.mjs';
import Bundled from '../../runtime/bundled-native.js';
import MachO from '../../runtime/macho-load-commands.js';
import Stage from '../../../../../scripts/stage-native-runtimes.cjs';
import Supplementals from '../../../../../scripts/native-supplementals.cjs';
import JsonFiles from '../../../../core/json-files.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const pin=JSON.parse(fs.readFileSync(path.join(root,'kosmickrisp-source.json')));
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const read=(command,args)=>execFileSync(command,args,{encoding:'utf8',maxBuffer:16*1024**2}).trim();
const system=value=>value.startsWith('/System/Library/')||value.startsWith('/usr/lib/');

/** Build only the original Kosmic driver and its normal Mesa shared compiler. */
export function buildKosmic(options){
 const {source,work,meson,ninja,llvm}=options;
 if(read('git',['-C',source,'rev-parse','HEAD'])!==pin.revision)throw Error('Kosmic source revision differs from its pin');
 const projected=path.join(work,'source'),build=path.join(work,'build');
 prepareSourceTree(projected,temporary=>{
  fs.cpSync(source,temporary,{recursive:true,filter:file=>path.basename(file)!=='.git'});
  for(const [file,content] of Object.entries(adaptedKosmicSources(source)))writeChanged(path.join(temporary,file),content);
 });
 const environment={...process.env,CC:'/usr/bin/clang',CXX:'/usr/bin/clang++',
  LLVM_CONFIG:path.join(llvm,'bin/llvm-config'),MACOSX_DEPLOYMENT_TARGET:pin.minimumMacOS,
  MESA_GIT_SHA1_OVERRIDE:pin.revision,CCACHE_DIR:path.join(work,'ccache'),CCACHE_MAXSIZE:'128M',
  PATH:[path.dirname(meson),path.join(llvm,'bin'),process.env.PATH].join(path.delimiter)};
 const args=['--buildtype=release','--wrap-mode=nofallback','-Dvulkan-drivers=kosmickrisp',
  '-Dgallium-drivers=[]','-Dplatforms=macos','-Dopengl=false','-Dgles1=disabled','-Dgles2=disabled',
  '-Degl=disabled','-Dglx=disabled','-Dgbm=disabled','-Dllvm=enabled','-Dshared-llvm=enabled',
  '-Dmesa-clc=enabled','-Dprecomp-compiler=enabled','-Dbuild-tests=false','-Dvideo-codecs=[]'];
 fs.mkdirSync(build,{recursive:true});
 run(meson,['setup',...(fs.existsSync(path.join(build,'build.ninja'))?['--reconfigure']:[]),build,projected,...args],{env:environment});
 const jobs=Number(options.jobs||2);
 if(!Number.isInteger(jobs)||jobs<1||jobs>4)throw Error('Kosmic builds use one to four compiler jobs');
 run(ninja,['-C',build,'-j',String(jobs),'src/kosmickrisp/vulkan/'+pin.library],{env:environment});
 return {library:path.join(build,'src/kosmickrisp/vulkan',pin.library),projected};
}

/** Publish a closed component using the existing native manifest semantics. */
export function publishKosmic({source,work,library,loader,loaderNotice,spirvNotice,zstdNotice,output}){
 const temporary=fs.mkdtempSync(path.join(work,'.kosmic-publication-'));
 try{
  const payload=path.join(temporary,'files');fs.mkdirSync(payload);
  const queue=[fs.realpathSync(library),fs.realpathSync(loader)],published=new Map(),links=[];
  for(let i=0;i<queue.length;i++){
   const original=queue[i];if(published.has(original))continue;
   const name=original===fs.realpathSync(loader)?'libvulkan.1.dylib':path.basename(original);
   const destination=path.join(payload,name);
   fs.copyFileSync(original,destination);fs.chmodSync(destination,0o755);published.set(original,name);
   const commands=Stage.loadCommands(original,'arm64'),ids=Stage.libraryIds(original,'arm64'),dependencies=[];
   for(const link of Stage.links(original,'arm64')){
    if(ids.includes(link))continue;
    if(system(link)){dependencies.push(link);continue;}
    const dependency=fs.realpathSync(Stage.resolveLink(link,original,library,commands.rpaths,'arm64'));
    const dependencyName=path.basename(dependency);
    run('/usr/bin/install_name_tool',['-change',link,'@loader_path/'+dependencyName,destination]);
    dependencies.push('@loader_path/'+dependencyName);queue.push(dependency);
   }
   for(const rpath of commands.rpaths.filter(value=>!system(value)))run('/usr/bin/install_name_tool',['-delete_rpath',rpath,destination]);
   if(ids.length)run('/usr/bin/install_name_tool',['-id','@rpath/'+name,destination]);
   run('/usr/bin/strip',['-S',destination]);
   run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',destination]);
   run('/usr/bin/codesign',['--verify','--strict',destination]);
   links.push({file:name,links:dependencies});
  }
  const licenseRoot=path.join(payload,'licenses');fs.mkdirSync(licenseRoot);
  const mesaLicense=execFileSync('git',['-C',source,'show',pin.revision+':docs/license.rst']);
  fs.writeFileSync(path.join(licenseRoot,'Mesa-license.rst'),mesaLicense);
  const notices=[{name:'Mesa',license:'MIT and upstream notices',sourceUrl:pin.repository,path:'licenses/Mesa-license.rst'}];
  for(const name of read('git',['-C',source,'ls-tree','-r','--name-only',pin.revision,'licenses/']).split('\n')){
   const relative='licenses/Mesa-'+path.basename(name);
   fs.writeFileSync(path.join(payload,relative),execFileSync('git',['-C',source,'show',pin.revision+':'+name]));
   notices.push({name:'Mesa '+path.basename(name),license:path.basename(name),sourceUrl:pin.repository,path:relative});
  }
  for(const item of [
   ['Vulkan-Loader','Apache-2.0','https://github.com/KhronosGroup/Vulkan-Loader',loaderNotice],
   ['SPIRV-Tools','Apache-2.0','https://github.com/KhronosGroup/SPIRV-Tools',spirvNotice],
   ['Zstandard','BSD-3-Clause','https://github.com/facebook/zstd',zstdNotice]
  ]){
   const [name,license,sourceUrl,file]=item,relative='licenses/'+name+'.txt';
   fs.copyFileSync(file,path.join(payload,relative));notices.push({name,license,sourceUrl,path:relative});
  }
  const files=Bundled.fileInventory(payload).map(relative=>{
   const file=path.join(payload,relative),stat=fs.statSync(file);
   const native=links.some(item=>item.file===relative);
   return {path:relative,size:stat.size,mode:stat.mode&0o777,sha256:sha(fs.readFileSync(file)),...(native?{architectures:['arm64']}:{})};
  });
  let minimumMacOS='0.0';
  for(const file of links){
   const info=MachO.readMachOLoadCommands(path.join(payload,file.file),{architecture:'arm64'});
   for(const slice of info.slices)if(Bundled.versionAtLeast(slice.minimumMacOS,minimumMacOS))minimumMacOS=slice.minimumMacOS;
  }
  const adaptations=['kosmickrisp-build.mjs','kosmickrisp-source.mjs','kosmickrisp-source.json','source-files.mjs'].map(file=>({file,sha256:sha(fs.readFileSync(path.join(root,file)))}));
  const sourceHash=sha(JSON.stringify({pin,adaptations})),version='0.1.0-'+sourceHash.slice(0,8)+'-'+sha(JSON.stringify(files)).slice(0,8);
  const manifest={schemaVersion:1,managerId:'vulkan-kosmickrisp-gles32',version,upstreamRevision:pin.revision,
   platform:'darwin',arch:'arm64',minimumMacOS,executableRelative:pin.library,files,dependencies:links,notices,
   runtimeFiles:{loader:'libvulkan.1.dylib'},provenance:{sourceRevision:pin.revision,verifiedBuild:true,
    sourceUrl:pin.repository,adaptations,capabilities:{openglES:'3.2',geometry:'Mesa Poly',transformFeedback:'Mesa Poly'}}};
  Bundled.validateManifest(manifest);Bundled.verifyPayload(payload,manifest);
  fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  // Matching source and adaptations are supplied by the tagged producer repository.
  fs.mkdirSync(output,{recursive:true});
  prepareSourceTree(output,pending=>fs.cpSync(temporary,pending,{recursive:true}));
  return manifest;
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
}

/** Register the independent sealed Vulkan component. */
export function stageKosmic({output,resourceRoot,declarationFile=path.join(root,'../distribution-supplementals.json')}){
 const manifest=Bundled.validateManifest(JSON.parse(fs.readFileSync(path.join(output,'manifest.json'))));
 Supplementals.validatePublicMetadata(manifest);
 Bundled.verifyPayload(path.join(output,'files'),manifest);
 const directoryRelative=[manifest.managerId,manifest.version,manifest.arch].join('/');
 const files=Bundled.fileInventory(output).map(relative=>{
  const full=path.join(output,relative),stat=fs.statSync(full),native=manifest.files.find(file=>'files/'+file.path===relative)?.architectures;
  return {path:relative,size:stat.size,mode:stat.mode&0o777,sha256:sha(fs.readFileSync(full)),...(native?{architectures:native}:{})};
 });
 const declaration={id:manifest.managerId,version:manifest.version,arch:manifest.arch,launcherArchitectures:['arm64'],
  minimumMacOS:manifest.minimumMacOS,directoryRelative,sourceRelative:null,
  sourceSha256:sha(JSON.stringify(manifest.provenance.adaptations)),manifestRelative:'manifest.json',
  manifestSha256:files.find(file=>file.path==='manifest.json').sha256,files,
  notices:manifest.notices.map(notice=>({...notice,path:'files/'+notice.path}))};
 Supplementals.validateDeclaration(declaration);
 prepareSourceTree(path.join(resourceRoot,directoryRelative),temporary=>fs.cpSync(output,temporary,{recursive:true}));
 const previous=fs.existsSync(declarationFile)?JSON.parse(fs.readFileSync(declarationFile)):[];
 JsonFiles.writeJsonAtomic(declarationFile,[...previous.filter(item=>item.id!==declaration.id||item.arch!==declaration.arch),declaration]);
 return declaration;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let i=2;i<process.argv.length;i+=2){if(!process.argv[i]?.startsWith('--')||!process.argv[i+1])throw Error('Expected --option value pairs');options[process.argv[i].slice(2)]=process.argv[i+1];}
 for(const name of ['source','work','meson','ninja','llvm','loader','loader-notice','spirv-notice','zstd-notice','output'])if(!options[name])throw Error('Missing --'+name);
 const built=buildKosmic(options);
 const manifest=publishKosmic({...options,...built,loaderNotice:options['loader-notice'],spirvNotice:options['spirv-notice'],zstdNotice:options['zstd-notice']});
 if(options['resource-root'])stageKosmic({output:options.output,resourceRoot:options['resource-root'],...(options.declaration?{declarationFile:options.declaration}:{})});
 console.log(JSON.stringify({output:options.output,version:manifest.version,minimumMacOS:manifest.minimumMacOS,bytes:manifest.files.reduce((sum,file)=>sum+file.size,0)}));
}
