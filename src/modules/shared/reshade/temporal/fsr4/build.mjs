import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url));
const pin=JSON.parse(await fs.readFile(path.join(here,'source.json'),'utf8'));
const [sourceArg,destinationArg,...flags]=process.argv.slice(2);
if(!sourceArg || !destinationArg)throw new Error('Usage: build.mjs SOURCE OUTPUT [--quick]');
const source=path.resolve(sourceArg),destination=path.resolve(destinationArg);
const quick=flags.includes('--quick');
const run=(command,args,options={})=>new Promise((resolve,reject)=>{
  const child=spawn(command,args,{stdio:'inherit',...options});
  child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`${command} exited ${code}`)));
});
const transform=async(file,changes)=>{
  let value=await fs.readFile(file,'utf8');
  for(const [before,after] of changes){
    if(!value.includes(before))throw new Error(`Source adaptation does not match ${path.basename(file)}`);
    value=value.replace(before,after);
  }
  await fs.writeFile(file,value);
};
// Export the pinned source into owned build storage; the checkout is read-only.
await fs.stat(path.join(source,'.git'));
await run('git',['-C',source,'diff','--exit-code',pin.commit,'--','src','tools','third_party']);
await fs.mkdir(destination,{recursive:true});
const work=path.join(destination,'source'),payload=path.join(destination,'payload');
await fs.mkdir(work,{recursive:true});
for(const name of ['src','tools','third_party'])await fs.cp(path.join(source,name),path.join(work,name),{recursive:true});
await fs.mkdir(payload,{recursive:true});
// Offline shader translation produces portable MSL. Metal itself compiles the
// selected pipelines on first use; an application never starts a compiler tool.
await transform(path.join(work,'tools/compile_fsr411.py'),[
  ['digest.update(run(["xcrun", "metal", "--version"]))','digest.update(b"maclauncher-msl-source-v1")'],
  ['        run(["xcrun", "metal", "-std=macos-metal2.3", optimization, *stage_math,\n             "-c", metal, "-o", air], output / f"{name}.metal.log")\n        run(["xcrun", "metallib", air, "-o", lib_path])','        # MSL is the portable library input in the MacLauncher payload.'],
]);
let compiler=await fs.readFile(path.join(work,'tools/compile_fsr411.py'),'utf8');
compiler=compiler.replaceAll('.metallib','.metal');
await fs.writeFile(path.join(work,'tools/compile_fsr411.py'),compiler);
await transform(path.join(work,'src/fsr411_runtime.h'),[
  ['            auto lib=[device_ newLibraryWithURL:url error:&e];',`            NSString *source=[NSString stringWithContentsOfURL:url encoding:NSUTF8StringEncoding error:&e];
            MTLCompileOptions *co=[MTLCompileOptions new];co.languageVersion=MTLLanguageVersion2_3;
            const bool relaxed=[entry[@"metal_math_mode"] isEqual:@"relaxed-fastfn"];
            const bool ordered=[entry[@"metal_math_mode"] isEqual:@"ordered-no-contract"];
            if(@available(macOS 15.0,*)) {
                co.mathMode=relaxed?MTLMathModeRelaxed:ordered?MTLMathModeSafe:MTLMathModeFast;
                co.mathFloatingPointFunctions=ordered?MTLMathFloatingPointFunctionsPrecise:MTLMathFloatingPointFunctionsFast;
            } else {error="FSR 4 shader arithmetic requires macOS 15 or newer";return nullptr;}
            auto lib=source?[device_ newLibraryWithSource:source options:co error:&e]:nil;`],
  ['    id<MTLResidencySet> residency = nil;','    id residency = nil; // Metal 4-only object, created behind its availability check.'],
  ['    bool busy = false;\n    bool retired() const {\n        return !busy || (constants && __atomic_load_n(',
    '    bool busy = false;\n    id<MTLCommandBuffer> completion = nil;\n    bool retired() const {\n        return !busy || (completion && completion.status==MTLCommandBufferStatusError) || (constants && __atomic_load_n('],
  ['        bool m4=![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];',
    '        bool m4=![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];\n        slot->completion=m4?nil:(id<MTLCommandBuffer>)cb;'],
  ['        const bool m4 = ![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];',
    '        const bool m4 = ![enc respondsToSelector:@selector(setBuffer:offset:atIndex:)];\n        slot->completion=m4?nil:(id<MTLCommandBuffer>)commandBuffer;'],
  ['        if (m4) [enc barrierAfterEncoderStages:MTLStageDispatch|MTLStageBlit beforeEncoderStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];',
    '        if (m4) {if(@available(macOS 26.0,*)) [enc barrierAfterEncoderStages:MTLStageDispatch|MTLStageBlit beforeEncoderStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];}'],
  ['        [enc barrierAfterQueueStages:MTLStageAll beforeStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];',
    '        if(@available(macOS 26.0,*)) [enc barrierAfterQueueStages:MTLStageAll beforeStages:MTLStageDispatch|MTLStageBlit visibilityOptions:MTL4VisibilityOptionDevice];'],
  ['        [enc barrierAfterStages:MTLStageDispatch|MTLStageBlit beforeQueueStages:MTLStageAll visibilityOptions:MTL4VisibilityOptionDevice];',
    '        if(@available(macOS 26.0,*)) [enc barrierAfterStages:MTLStageDispatch|MTLStageBlit beforeQueueStages:MTLStageAll visibilityOptions:MTL4VisibilityOptionDevice];'],
]);
await fs.writeFile(path.join(work,'src/fsr4_log.h'),'#pragma once\nstatic inline void fsr4_logf(const char *, ...) {}\n');
const pythonArgs=['run','--python','3.12','--no-project'];
const python=(script,args)=>run('uv',[...pythonArgs,path.join(work,script),...args],{
  env:{...process.env,UV_CACHE_DIR:path.join(destination,'uv-cache')}
});
const build=path.join(work,'build');
const tiers=quick?[1080]:[1080,2160,4320];
for(const tier of tiers)for(const ultra of quick?[0]:[0,1]){
  await python('tools/gen_fsr411_native.py',['--tier',String(tier),'--profile','exact','--preset',ultra?'ultraperformance':'normal',
    '--outdir',path.join(build,`fsr411_native_${tier}${ultra?'_ultraperformance':''}`)]);
  for(const depth of quick?[0]:[0,1])for(const low of quick?[1]:[0,1])for(const jitter of quick?[0]:[0,1])for(const exposure of quick?[0]:[0,1]){
    await python('tools/compile_fsr411.py',['--root',work,'--builddir',build,'--res',String(tier),'--profile','exact-fast',
      '--optimize','1','--external-post-cnb','1','--post-cnb-alias','1','--depth-inverted',String(depth),'--low-res-mv',String(low),
      '--jittered-mv',String(jitter),'--auto-exposure',String(exposure),'--ultra-performance',String(ultra)]);
  }
}
await fs.mkdir(path.join(payload,'build'),{recursive:true});
const shared=path.join(payload,'build/libraries');await fs.mkdir(shared,{recursive:true});
const copied=new Set();
// Discard compiler tools, HLSL trees, intermediate SPIR-V and duplicated caches.
for(const dir of await fs.readdir(build)){
  if(!/^fsr411_\d|^fsr411_native_/.test(dir))continue;
  const to=path.join(payload,'build',dir);await fs.mkdir(to,{recursive:true});
  if(/^fsr411_\d/.test(dir)){
    const manifest=JSON.parse(await fs.readFile(path.join(build,dir,'bindings.json'),'utf8'));
    for(const entry of Object.values(manifest.kernels))for(const property of ['library','literal_tables']){
      if(!entry[property])continue;
      const bytes=await fs.readFile(path.join(build,dir,entry[property]));
      const name=createHash('sha256').update(bytes).digest('hex')+path.extname(entry[property]);
      if(!copied.has(name)){await fs.writeFile(path.join(shared,name),bytes);copied.add(name);}
      entry[property]='../libraries/'+name;
    }
    // Old output from a prior developer build must not retain duplicate files.
    for(const file of await fs.readdir(to))await fs.unlink(path.join(to,file));
    await fs.writeFile(path.join(to,'bindings.json'),JSON.stringify(manifest)+'\n');
    continue;
  }
  for(const file of await fs.readdir(path.join(build,dir))){
    if(!/\.metal$|\.bin$|^bindings\.json$|^fsr411_native_manifest\.json$/.test(file))continue;
    await fs.copyFile(path.join(build,dir,file),path.join(to,file));
  }
}
await fs.mkdir(path.join(payload,'src'),{recursive:true});
for(const file of ['fsr411_model.h','fsr411_helpers.metal','fsr411_mpp.metal','fsr411_simd.metal','fsr411_reference.metal'])
  await fs.copyFile(path.join(work,'src',file),path.join(payload,'src',file));
await fs.mkdir(path.join(payload,'third_party/fsr411'),{recursive:true});
for(const file of ['initializers.bin','initializers-ultraperformance.bin','LICENSE','LICENSE.AMD.md'])
  await fs.copyFile(path.join(work,'third_party/fsr411',file),path.join(payload,'third_party/fsr411',file));
for(const arch of ['arm64','x86_64'])await run('xcrun',['clang++','-std=c++17','-O2','-fobjc-arc','-fvisibility=hidden','-dynamiclib',
  '-arch',arch,'-mmacosx-version-min=13.0','-Werror=unguarded-availability','-I',path.join(work,'src'),path.join(here,'provider.mm'),
  '-framework','Foundation','-framework','Metal','-install_name','@rpath/libmaclauncher-fsr4.dylib',
  '-o',path.join(destination,`fsr4-${arch}.dylib`)]);
await run('xcrun',['lipo','-create',path.join(destination,'fsr4-arm64.dylib'),path.join(destination,'fsr4-x86_64.dylib'),
  '-output',path.join(payload,'libmaclauncher-fsr4.dylib')]);
await run('codesign',['--force','--sign','-',path.join(payload,'libmaclauncher-fsr4.dylib')]);
await fs.copyFile(path.join(here,'NOTICE.md'),path.join(payload,'NOTICE.md'));
await fs.writeFile(path.join(payload,'provider.json'),JSON.stringify({...pin,providerABI:1,complete:!quick,loadMinimumMacOS:'13.0',
  profile:'exact-fast',colorSpace:'linear',maximumOutput:[7680,4320],library:'libmaclauncher-fsr4.dylib'},null,2)+'\n');
console.log(payload);
