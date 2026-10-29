#!/usr/bin/env node
// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=import.meta.dirname,args=Object.fromEntries(process.argv.slice(2).reduce((rows,value,index,all)=>index%2?rows:[...rows,[value.replace(/^--/,''),all[index+1]]],[]));
if(!args.sdk||!args.compiler||!args.out)throw Error('Use --sdk XESS_SOURCE --compiler LLVM_MINGW_BIN --out OUTPUT');
const sdk=fs.realpathSync(args.sdk),compiler=path.resolve(args.compiler),output=path.resolve(args.out),sourceFile=fs.existsSync(path.join(here,'../source.json'))?path.join(here,'../source.json'):path.join(here,'source.json'),source=JSON.parse(fs.readFileSync(sourceFile,'utf8'));
if(execFileSync('git',['-C',sdk,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==source.commit)throw Error('Initialize the exact declared Intel XeSS SDK commit.');
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
if(sha(path.join(sdk,'bin/libxess.dll'))!==source.sha256)throw Error('The pinned original Intel XeSS runtime differs from its declared identity.');
const componentFile=fs.existsSync(path.join(here,'../components.json'))?path.join(here,'../components.json'):path.join(here,'components.json'),components=JSON.parse(fs.readFileSync(componentFile,'utf8'));
if(components.commit!==source.commit)throw Error('XeSS generation components differ from the SDK source pin.');
for(const component of components.files)if(sha(path.join(sdk,'bin',component.file))!==component.sha256||fs.statSync(path.join(sdk,'bin',component.file)).size!==component.bytes)throw Error('An original XeSS generation component differs from its declared identity.');
const windows=path.join(output,'x86_64-windows'),unix=path.join(output,'x86_64-unix');fs.mkdirSync(windows,{recursive:true});fs.mkdirSync(unix,{recursive:true});
const run=(file,argv)=>execFileSync(file,argv,{stdio:'pipe',maxBuffer:8*1024*1024});
const cxx=path.join(compiler,'x86_64-w64-mingw32-clang++'),cc=path.join(compiler,'x86_64-w64-mingw32-clang');
// Every output is compiled and linked in one step; a zero PE timestamp keeps rebuilds byte-identical.
const common=['-O2','-static','-Wl,--no-insert-timestamp','-ffile-prefix-map='+here+'=MacLauncherXeSS','-I'+here,'-I'+path.join(sdk,'inc')];
run(cxx,['-std=c++17',...common,path.join(here,'host.cpp'),'-ld3d12','-ldxgi','-luuid','-o',path.join(windows,'maclauncher-xess-host.exe')]);
run(cxx,['-std=c++17',...common,path.join(here,'host-fg.cpp'),'-ld3d12','-ldxgi','-luuid','-luser32','-o',path.join(windows,'maclauncher-xess-fg-host.exe')]);
const vulkanSource=JSON.parse(fs.readFileSync(path.join(here,'vulkan-source.json'),'utf8'));
let vulkanHeaders=null;
if(args['vulkan-source']){
  const root=fs.realpathSync(args['vulkan-source']);
  if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==vulkanSource.commit||
      execFileSync('git',['-C',root,'remote','get-url','origin'],{encoding:'utf8'}).trim().replace(/\.git$/,'')!==vulkanSource.repository)
    throw Error('Initialize the exact declared Vulkan header source commit.');
  vulkanHeaders=path.join(root,vulkanSource.headerDirectory);
}else if(fs.existsSync(path.join(here,'vulkan/vulkan.h')))vulkanHeaders=path.join(here,'vulkan');
if(vulkanHeaders){
  for(const row of vulkanSource.headers)if(sha(path.join(vulkanHeaders,row.path))!==row.sha256)throw Error('A Vulkan header differs from its exact source pin.');
  const include=path.join(output,'.include','vulkan');fs.mkdirSync(include,{recursive:true});
  for(const row of vulkanSource.headers)fs.copyFileSync(path.join(vulkanHeaders,row.path),path.join(include,row.path));
  try{run(cxx,['-std=c++17',...common,'-I'+path.dirname(include),path.join(here,'host-vulkan.cpp'),'-o',path.join(windows,'maclauncher-xess-vulkan-host.exe')]);}
  finally{fs.rmSync(path.join(output,'.include'),{recursive:true,force:true});}
}
run(cc,[...common,'-shared',path.join(here,'bridge.c'),'-o',path.join(windows,'maclauncher-xess-gpu.dll')]);
const thunk=path.join(windows,'maclauncher-xess-gpu.dll'),bytes=fs.readFileSync(thunk);if(bytes.readUInt32LE(0x3c)<80)throw Error('The helper PE image has no builtin marker space.');bytes.write('Wine builtin DLL\0',64,'ascii');fs.writeFileSync(thunk,bytes);
const native=path.join(unix,'maclauncher-xess-gpu.so');run('xcrun',['clang++','-std=c++17','-fobjc-arc','-arch','x86_64','-mmacosx-version-min=13','-dynamiclib','-O2','-ffile-prefix-map='+here+'=MacLauncherXeSS',path.join(here,'bridge.mm'),'-framework','Foundation','-framework','Metal','-framework','IOSurface','-Wl,-install_name,@rpath/maclauncher-xess-gpu.so','-o',native]);run('codesign',['--force','--sign','-',native]);
const ownedFiles=['host.cpp','host-vulkan.cpp','host-fg.cpp','offscreen-swapchain.hpp','xess-fg-protocol.h','bridge.c','bridge.mm','xess-protocol.h','xess-wire.hpp','build.mjs','vulkan-source.json','KHRONOS-APACHE-2.0.txt'].map(file=>({path:file,sha256:sha(path.join(here,file))}));
const sourceDirectory=path.join(output,'source');fs.mkdirSync(sourceDirectory,{recursive:true});for(const row of ownedFiles)fs.copyFileSync(path.join(here,row.path),path.join(sourceDirectory,row.path));fs.copyFileSync(sourceFile,path.join(sourceDirectory,'source.json'));fs.copyFileSync(componentFile,path.join(sourceDirectory,'components.json'));
if(vulkanHeaders){const target=path.join(sourceDirectory,'vulkan');fs.mkdirSync(target,{recursive:true});for(const row of vulkanSource.headers)fs.copyFileSync(path.join(vulkanHeaders,row.path),path.join(target,row.path));fs.copyFileSync(path.join(here,'KHRONOS-APACHE-2.0.txt'),path.join(output,'KHRONOS-APACHE-2.0.txt'));}
fs.copyFileSync(path.join(sdk,'LICENSE.txt'),path.join(output,'INTEL-LICENSE.txt'));fs.copyFileSync(path.join(sdk,'third-party-programs.txt'),path.join(output,'INTEL-THIRD-PARTY.txt'));
fs.writeFileSync(path.join(output,'LICENSE.txt'),'Copyright (c) MacLauncher contributors\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n');
const files=[];function inventory(directory,prefix=''){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const relative=path.posix.join(prefix,entry.name),file=path.join(directory,entry.name);if(entry.isDirectory())inventory(file,relative);else if(relative!=='provider.json')files.push({path:relative,size:fs.statSync(file).size,sha256:sha(file)});}}inventory(output);
const descriptor={schema:1,providerABI:1,backend:'d3d12',backends:['d3d12',...(vulkanHeaders?['vulkan']:[])],architecture:'x86_64',minimumMacOS:'13.0.0',hostPath:'x86_64-windows/maclauncher-xess-host.exe',hostPaths:{d3d12:'x86_64-windows/maclauncher-xess-host.exe',...(vulkanHeaders?{vulkan:'x86_64-windows/maclauncher-xess-vulkan-host.exe'}:{})},bridge:{name:'maclauncher-xess-gpu',windows:'x86_64-windows/maclauncher-xess-gpu.dll',unix:'x86_64-unix/maclauncher-xess-gpu.so'},sdk:{repository:source.repository,commit:source.commit,sha256:source.sha256,bytes:source.bytes},source:{repository:'https://github.com/procrastinine/maclauncher',sdkRevision:source.commit,ownedFiles,...(vulkanHeaders?{vulkanHeaders:vulkanSource}:{})},generation:{providerABI:1,hostPath:'x86_64-windows/maclauncher-xess-fg-host.exe',backend:'d3d12',operation:'interpolate',maxInterpolatedFrames:1,requires:['color','depth','motion','viewMatrix','projectionMatrix'],formats:['rgba8-srgb','rgb10a2-pq-bt2020'],componentsSha256:sha(componentFile),sdk:Object.fromEntries(components.files.map(component=>[component.id,{path:'bin/'+component.file,sha256:component.sha256,bytes:component.bytes}]))},transport:{version:1,surfaces:'iosurface',pixels:'gpu',copies:'aliased-gpu-buffers',maxInFlight:3,opaqueModelAllocations:true},files:files.sort((a,b)=>a.path.localeCompare(b.path))};
fs.writeFileSync(path.join(output,'provider.json'),JSON.stringify(descriptor,null,2)+'\n');console.log(JSON.stringify({output,host:descriptor.hostPath,files:files.length}));
