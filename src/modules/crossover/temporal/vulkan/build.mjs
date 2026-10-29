// Copyright (c) MacLauncher contributors. MIT license.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {source,applyProfile} from './overlay.mjs';
import {prepareSourceTree,writeChanged} from '../../../shared/vulkan/native/source-files.mjs';
const here=import.meta.dirname;
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const run=(command,args,options={})=>execFileSync(command,args,{stdio:'inherit',...options});
const read=(command,args,options={})=>execFileSync(command,args,{encoding:'utf8',maxBuffer:16<<20,...options}).trim();
async function verifyArchive(file,description){
    file=fs.realpathSync(file);const hash=crypto.createHash('sha256');
    for await(const bytes of fs.createReadStream(file))hash.update(bytes);
    if(hash.digest('hex')!==description.sha256 || description.bytes&&fs.statSync(file).size!==description.bytes)
        throw Error('The source archive differs from its public digest: '+description.url);
    return file;
}
export function checkSources(){
    const owned=Object.fromEntries(source.ownedFiles.map(file=>[file,digest(fs.readFileSync(path.join(here,file)))]));
    const shared=Object.fromEntries(source.sharedHeaders.map(file=>[file,digest(fs.readFileSync(path.resolve(here,'../../../shared',file)))]));
    return {profile:source.profile,version:source.version,source:source.archive,owned,shared};
}
export async function prepareSource({archive,work}){
    archive=await verifyArchive(archive,source.archive);work=path.resolve(work);
    const identity=checkSources(),key=digest(Buffer.from(JSON.stringify(identity))),receipt=path.join(work,'source-inputs.json'),directory=path.join(work,'source');
    if(fs.existsSync(receipt)&&fs.existsSync(directory)){
        const previous=JSON.parse(fs.readFileSync(receipt));
        if(previous.key===key&&previous.files.every(row=>fs.existsSync(path.join(directory,row.path))&&digest(fs.readFileSync(path.join(directory,row.path)))===row.sha256))
            return {directory,key,identity,reused:true};
    }
    fs.mkdirSync(work,{recursive:true});let adaptation;
    prepareSourceTree(directory,temporary=>{
        run('/usr/bin/tar',['-xzf',archive,'--no-same-owner','--strip-components=2','-C',temporary,source.archive.directory]);
        adaptation=applyProfile(temporary);
    });
    const files=adaptation.files.map(file=>({path:file,sha256:digest(fs.readFileSync(path.join(directory,file)))}));
    writeChanged(receipt,JSON.stringify({key,identity,files},null,2)+'\n');
    return {directory,key,identity,reused:false};
}
async function buildBison({archive,work,jobs}){
    const tool=source.buildTools.bison;archive=await verifyArchive(archive,tool);
    const root=path.join(work,'bison'),sourceDir=path.join(root,'source'),build=path.join(root,'build'),prefix=path.join(root,'output'),executable=path.join(prefix,'bin/bison');
    if(fs.existsSync(executable)&&read(executable,['--version']).startsWith('bison (GNU Bison) '+tool.version))return executable;
    if(!fs.existsSync(sourceDir)){fs.mkdirSync(sourceDir,{recursive:true});run('/usr/bin/tar',['-xf',archive,'--no-same-owner','--strip-components=1','-C',sourceDir,tool.directory]);}
    fs.mkdirSync(build,{recursive:true});
    if(!fs.existsSync(path.join(build,'Makefile')))run('/bin/sh',[path.join(sourceDir,'configure'),'--prefix='+prefix,'--disable-nls'],{cwd:build});
    run('/usr/bin/nice',['-n','10','make','-j'+jobs],{cwd:build});
    run('/usr/bin/nice',['-n','10','make','install'],{cwd:build});
    if(!read(executable,['--version']).startsWith('bison (GNU Bison) '+tool.version))throw Error('The declared Bison tool did not build.');
    return executable;
}
async function prepareVulkanLink({moltenvkArchive,vulkanLibrary,work}){
    const input=source.vulkanLinkInput;
    if(moltenvkArchive){
        const archive=await verifyArchive(moltenvkArchive,input.archive);
        const directory=path.join(work,'inputs','moltenvk');
        fs.mkdirSync(directory,{recursive:true});
        run('/usr/bin/tar',['-xf',archive,'--no-same-owner','-C',directory,input.file]);
        vulkanLibrary=path.join(directory,input.file);
    }
    if(!vulkanLibrary)throw Error('The declared MoltenVK archive or exact library is required.');
    vulkanLibrary=fs.realpathSync(vulkanLibrary);
    const sha256=digest(fs.readFileSync(vulkanLibrary));
    if(sha256!==input.sha256)throw Error('The Vulkan link input differs from the declared MoltenVK release.');
    run('/usr/bin/lipo',['-verify_arch',input.architecture,vulkanLibrary]);
    return {library:vulkanLibrary,sha256};
}
export async function buildModule(options){
    const work=path.resolve(options.work),jobs=Number(options.jobs||2);
    if(!Number.isInteger(jobs)||jobs<1||jobs>2)throw Error('Use one or two compiler jobs.');
    if(/\s/.test(work))throw Error('The Wine Makefile requires a build directory without whitespace.');
    const prepared=await prepareSource({archive:options.archive,work});
    if(options.prepareOnly)return prepared;
    const mingw=fs.realpathSync(options.mingw),build=path.join(work,'build'),vulkan=await prepareVulkanLink({...options,work});
    for(const name of ['x86_64-w64-mingw32-clang','i686-w64-mingw32-clang'])fs.accessSync(path.join(mingw,name),fs.constants.X_OK);
    const bison=options.bison?fs.realpathSync(options.bison):options.bisonArchive?await buildBison({archive:options.bisonArchive,work,jobs}):'bison';
    const cc=read('xcrun',['--find','clang']),sdk=read('xcrun',['--sdk','macosx','--show-sdk-path']);
    const wrapper=path.join(work,'clang-x86_64'),linkDirectory=path.join(work,'vulkan-link');
    writeChanged(wrapper,'#!/bin/sh\nexec '+[cc,'-arch','x86_64','-isysroot',sdk,'-mmacosx-version-min='+source.minimumMacOS].map(quote).join(' ')+' "$@"\n',0o755);
    writeChanged(path.join(linkDirectory,'libMoltenVK.dylib'),fs.readFileSync(vulkan.library));
    const environment={...process.env,PATH:mingw+path.delimiter+path.dirname(bison)+path.delimiter+process.env.PATH,
        CC:wrapper,
        SDKROOT:sdk,MACOSX_DEPLOYMENT_TARGET:source.minimumMacOS,
        CFLAGS:'-O2',CPPFLAGS:'',LDFLAGS:'-L'+linkDirectory,BISON:bison};
    fs.mkdirSync(build,{recursive:true});
    const configured=path.join(build,'configuration.json'),environmentKey=digest(Buffer.from(JSON.stringify({CC:environment.CC,LDFLAGS:environment.LDFLAGS,bison,mingw,sdk,vulkan: vulkan.sha256}))),configureKey=digest(Buffer.from(JSON.stringify({source:prepared.key,environmentKey})));
    if(!fs.existsSync(configured)||JSON.parse(fs.readFileSync(configured)).key!==configureKey){
        if(fs.existsSync(path.join(build,'config.cache'))&&(!fs.existsSync(configured)||JSON.parse(fs.readFileSync(configured)).environmentKey!==environmentKey))fs.unlinkSync(path.join(build,'config.cache'));
        run('/usr/bin/arch',['-x86_64','/bin/sh',path.join(prepared.directory,'configure'),'--host=x86_64-apple-darwin','--enable-archs=i386,x86_64','--disable-tests','--without-x','--without-freetype','--cache-file=config.cache'],{cwd:build,env:environment});
        writeChanged(configured,JSON.stringify({key:configureKey,source:prepared.key,environmentKey,vulkan:{name:source.vulkanLinkInput.library,sha256:vulkan.sha256,archive:source.vulkanLinkInput.archive}},null,2)+'\n');
    }
    if(options.configureOnly)return {...prepared,build};
    const flags='-g -O2 '+[work,fs.realpathSync(work),prepared.directory,fs.realpathSync(prepared.directory)].map(root=>'-ffile-prefix-map='+root+'=WineSource').join(' '),flagFile=path.join(build,'module-compiler-flags.txt');
    if(!fs.existsSync(flagFile)||fs.readFileSync(flagFile,'utf8')!==flags+'\n')
        run('/usr/bin/nice',['-n','10','make','dlls/winevulkan/clean'],{cwd:build,env:environment});
    const makefile=fs.readFileSync(path.join(build,'Makefile'),'utf8');
    const peLinkerFlags=Object.fromEntries(['i386','x86_64'].map(architecture=>{
        const match=makefile.match(new RegExp('^'+architecture+'_LDFLAGS = (.*)$','m'));
        if(!match)throw Error('The generated PE linker flags are unavailable: '+architecture);
        return [architecture,match[1]+' '+source.peLinkerFlags.join(' ')];
    }));
    const linkerFile=path.join(build,'module-pe-linker-flags.json'),linkerIdentity=JSON.stringify(peLinkerFlags)+'\n';
    if(!fs.existsSync(linkerFile)||fs.readFileSync(linkerFile,'utf8')!==linkerIdentity)
        for(const architecture of Object.keys(peLinkerFlags))
            fs.rmSync(path.join(build,'dlls/winevulkan',architecture+'-windows/winevulkan.dll'),{force:true});
    run('/usr/bin/nice',['-n','10','make','-j'+jobs,'i386_CFLAGS='+flags,'x86_64_CFLAGS='+flags,
        ...Object.entries(peLinkerFlags).map(([architecture,value])=>architecture+'_LDFLAGS='+value),'dlls/winevulkan/all'],{cwd:build,env:environment});
    writeChanged(flagFile,flags+'\n');
    writeChanged(linkerFile,linkerIdentity);
    const files=['dlls/winevulkan/x86_64-windows/winevulkan.dll','dlls/winevulkan/i386-windows/winevulkan.dll','dlls/winevulkan/winevulkan.so'];
    for(const file of files)if(!fs.statSync(path.join(build,file),{throwIfNoEntry:false})?.isFile())throw Error('The paired module output is missing: '+file);
    const result={...prepared,build,files,readobj:path.join(mingw,'llvm-readobj'),strip:path.join(mingw,'llvm-strip')};
    if(options.output)result.provider=publishModule(result,path.resolve(options.output));
    return result;
}
export function publishModule(built,output){
    if(fs.existsSync(output))throw Error('The immutable module output already exists.');
    const binaries=[['x86_64-unix/winevulkan.so',built.files[2]],['x86_64-windows/winevulkan.dll',built.files[0]],['i386-windows/winevulkan.dll',built.files[1]]];
    const native=read('/usr/bin/nm',['-gU',path.join(built.build,built.files[2])]);
    for(const name of [...source.nativeExports,'__wine_unix_call_funcs','__wine_unix_call_wow64_funcs'])
        if(!native.split('\n').some(line=>line.trim().endsWith(' _'+name)))throw Error('The native module export is missing: '+name);
    const originalSpec=fs.readFileSync(path.join(built.directory,'dlls/winevulkan/winevulkan.spec'),'utf8');
    const expected=[...originalSpec.matchAll(/^@\s+\S+\s+(?:-\S+\s+)*([A-Za-z0-9_]+)(?:\(|\s*$)/gm)].map(row=>row[1]).sort();
    for(const [,file]of binaries.slice(1)){
        const actual=[...read(built.readobj,['--coff-exports',path.join(built.build,file)]).matchAll(/^\s+Name: ([A-Za-z0-9_]+)$/gm)].map(row=>row[1]).sort();
        if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('The complete PE Vulkan export set differs: '+file);
    }
    fs.mkdirSync(output,{recursive:true});
    for(const [name,file]of binaries){
        const target=path.join(output,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(built.build,file),target);fs.chmodSync(target,0o755);
        if(name.endsWith('.dll'))run(built.strip,['--strip-debug',target]);
        else run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',target]);
    }
    fs.mkdirSync(path.join(output,'notices'));
    for(const file of source.licenses)fs.copyFileSync(path.join(built.directory,file),path.join(output,'notices/Wine-'+file));
    const mit=fs.readFileSync(path.resolve(here,'../../../../../LICENSE'),'utf8');
    writeChanged(path.join(output,'notices/MacLauncher-MIT'),mit);
    const permission=mit.slice(mit.indexOf('Permission is hereby granted'));
    if(!permission.startsWith('Permission is hereby granted'))throw Error('The owned MIT license changed.');
    writeChanged(path.join(output,'notices/Khronos-Vulkan-MIT'),source.generatedCopyrights.join('\n')+'\n\n'+permission);
    const files=[...binaries.map(([name])=>name),...source.licenses.map(name=>'notices/Wine-'+name),'notices/MacLauncher-MIT','notices/Khronos-Vulkan-MIT'].map(file=>{
        const binary=binaries.some(([name])=>name===file),native=file.endsWith('.so'),target=path.join(output,file);
        fs.chmodSync(target,binary?0o755:0o644);
        return {path:file,size:fs.statSync(target).size,mode:binary?0o755:0o644,sha256:digest(fs.readFileSync(target)),
            ...(binary?{format:native?'mach-o':'pe',architectures:[file.startsWith('i386-windows/')?'x86':'x86_64'],
                ...(native?{executionArchitecture:'x86_64'}:{})}:{})};
    });
    const provider={schema:1,provider:source.id,version:source.version,profile:source.profile,
        sceneInteropAPI:1,sceneContextAPI:1,wineVulkanDriverVersion:source.wineVulkanDriverVersion,originalUnixCallCount:source.unixCallCount,runtimeProfile:source.runtimeProfile,
        minimumMacOS:source.minimumMacOS,architectures:source.architectures,originalGpuWorkRetained:true,
        libraries:Object.fromEntries(binaries.map(([file])=>[file.split('/')[0],file])),files};
    writeChanged(path.join(output,'provider.json'),JSON.stringify(provider,null,2)+'\n');
    const notices=[...source.licenses.map(name=>({name:'Wine '+name,license:name==='COPYING.LIB'?'LGPL-2.1-or-later':'See included notice',
        sourceUrl:source.sourcePage,path:'notices/Wine-'+name})),
        {name:'MacLauncher',license:'MIT',sourceUrl:'https://github.com/procrastinine/maclauncher',path:'notices/MacLauncher-MIT'},
        {name:'Khronos Vulkan',license:'MIT',sourceUrl:'https://github.com/KhronosGroup/Vulkan-Headers',path:'notices/Khronos-Vulkan-MIT'}];
    const manifest={schemaVersion:1,managerId:source.id,version:source.version,platform:'darwin',arch:'x64',minimumMacOS:source.minimumMacOS,
        executableRelative:provider.libraries['x86_64-unix'],provider,files,notices,dependencies:[]};
    const payload=path.join(output,'payload');fs.mkdirSync(payload);
    for(const file of files){const target=path.join(payload,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(path.join(output,file.path),target);fs.chmodSync(target,file.mode);}
    const manifestFile=path.join(payload,'manifest.json');writeChanged(manifestFile,JSON.stringify(manifest,null,2)+'\n');
    const declaration={id:source.id,version:source.version,arch:'x64',launcherArchitectures:['arm64','x64'],minimumMacOS:source.minimumMacOS,
        sourceRelative:null,sourceSha256:digest(fs.readFileSync(path.join(here,'source.json'))),directoryRelative:[source.id,source.version,'x64'].join('/'),
        manifestRelative:'manifest.json',manifestSha256:digest(fs.readFileSync(manifestFile)),files:[...files,{path:'manifest.json',
            size:fs.statSync(manifestFile).size,mode:0o644,sha256:digest(fs.readFileSync(manifestFile))}],notices};
    writeChanged(path.join(output,'runtime-package.json'),JSON.stringify(declaration,null,2)+'\n');return provider;
}
if(process.argv[1]&&fs.existsSync(process.argv[1])&&pathToFileURL(fs.realpathSync(process.argv[1])).href===import.meta.url){
    try{
        const options={};for(let i=2;i<process.argv.length;i++){
            const key=process.argv[i];if(['--check','--prepare-only','--configure-only'].includes(key)){options[key.slice(2).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=true;continue;}
            if(!['--archive','--work','--mingw','--moltenvk-archive','--vulkan-library','--bison','--bison-archive','--jobs','--output'].includes(key)||!process.argv[i+1])throw Error('Use --check or --archive SOURCE --work DIRECTORY --mingw BIN [--moltenvk-archive ARCHIVE | --vulkan-library EXACT_LIBRARY] [--bison EXECUTABLE | --bison-archive SOURCE] [--jobs 1|2] [--output NEW_DIRECTORY].');
            options[key.slice(2).replace(/-([a-z])/g,(_,x)=>x.toUpperCase())]=process.argv[++i];
        }
        if(options.check)console.log(JSON.stringify(checkSources(),null,2));
        else if(!options.archive||!options.work||!options.prepareOnly&&(!options.mingw||!options.moltenvkArchive&&!options.vulkanLibrary))throw Error('An exact source archive, owned work directory, compiler directory and declared Vulkan link input are required.');
        else console.log(JSON.stringify(await buildModule(options),null,2));
    }catch(error){console.error(error.stack||error);process.exitCode=1;}
}
