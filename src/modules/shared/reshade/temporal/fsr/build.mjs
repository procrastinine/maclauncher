#!/usr/bin/env node
// Offline AMD HLSL -> SPIR-V -> Metal build. Runtime use needs no shader tools.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const [sourceArg, toolsArg, outputArg] = process.argv.slice(2);
if (!outputArg) throw new Error('Usage: build.mjs <FidelityFX-FSR2> <tools containing dxc and spirv-cross> <output>');
const source = path.resolve(sourceArg), tools = path.resolve(toolsArg), out = path.resolve(outputArg);
const fsr3=process.argv.includes('--fsr3');
const group=fsr3?'fsr3':'fsr2', shaderPrefix=fsr3?'fsr3upscaler':'fsr2';
const pin = fsr3?'c6efa6bf7f2027b3ec94f28578bb5965eabb9e55':'1680d1edd5c034f88ebbbb793d8b88f8842cf804';
const run = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
if (run('git', ['-C', source, 'rev-parse', 'HEAD']).trim() !== pin) throw new Error('FSR2 source revision differs from the build pin.');
const api = path.join(source, fsr3?'sdk/src/components/fsr3upscaler':'src/ffx-fsr2-api');
const shaders = fsr3?path.join(source,'sdk/src/backends/dx12/shaders/fsr3upscaler'):path.join(api, 'shaders');
const shaderIncludes=fsr3?path.join(source,'sdk/include/FidelityFX/gpu'):shaders;
await fs.mkdir(out, { recursive: true });
const hostOverlay=path.join(out,'host-overlay');
if(fsr3){
  // SDK context capacity assumes two-byte Windows wchar_t in binding names.
  // Darwin uses four bytes; preserve the SDK's size assertion and allocate the
  // corresponding capacity instead of changing wchar_t's libc ABI.
  const header=await fs.readFile(path.join(source,'sdk/include/FidelityFX/host/ffx_fsr3upscaler.h'),'utf8');
  const from='#define FFX_FSR3UPSCALER_CONTEXT_SIZE (FFX_SDK_DEFAULT_CONTEXT_SIZE)';
  if(!header.includes(from))throw new Error('FSR3 context capacity declaration changed.');
  await fs.mkdir(path.join(hostOverlay,'FidelityFX/host'),{recursive:true});
  await fs.writeFile(path.join(hostOverlay,'FidelityFX/host/ffx_fsr3upscaler.h'),header.replace(from,'#define FFX_FSR3UPSCALER_CONTEXT_SIZE (FFX_SDK_DEFAULT_CONTEXT_SIZE * (sizeof(wchar_t) / 2))'));
}
const passes = fsr3?['prepare_inputs','luma_pyramid','shading_change_pyramid','shading_change','prepare_reactivity','luma_instability','accumulate','accumulate','rcas','debug_view','autogen_reactive']:['depth_clip', 'reconstruct_previous_depth', 'lock', 'accumulate', 'accumulate', 'rcas', 'compute_luminance_pyramid', 'autogen_reactive', 'tcr_autogen'];
const signatures = (msl, reflected) => {
  const entry = /kernel\s+void\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);
  if (!entry) throw new Error('Metal shader entry is missing.');
  const args = entry[2];
  const bindings = [];
  for (const m of args.matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)) {
    bindings.push({ name: m[1], kind: m[2], index: +m[3] });
  }
  return { entry: entry[1], threads: reflected.entryPoints[0].workgroup_size, bindings };
};
// Jitter cancellation is also performed by AMD's CPU constants. Keep its shader
// permutation independent so updated source does not silently change semantics.
for (let flags = 0; !process.argv.includes('--native-only') && flags < 16; ++flags) {
  const dir = path.join(out, group, String(flags));
  await fs.mkdir(dir, { recursive: true });
  for (let pass = 0; pass < passes.length; ++pass) {
    const name = String(pass), spv = path.join(dir, `${name}.spv`), metal = path.join(dir, `${name}.metal`);
    const defines = {
      FFX_GPU: 1, FFX_HLSL: 1, FFX_HALF: 0,
      FFX_FSR2_OPTION_HDR_COLOR_INPUT: flags & 1 ? 1 : 0,
      FFX_FSR2_OPTION_INVERTED_DEPTH: flags & 2 ? 1 : 0,
      FFX_FSR2_OPTION_LOW_RESOLUTION_MOTION_VECTORS: flags & 4 ? 0 : 1,
      FFX_FSR2_OPTION_JITTERED_MOTION_VECTORS: flags & 8 ? 1 : 0,
      FFX_FSR2_OPTION_APPLY_SHARPENING: pass === (fsr3?7:4) ? 1 : 0,
      FFX_FSR2_OPTION_REPROJECT_USE_LANCZOS_TYPE: 1,
      FFX_FSR2_OPTION_UPSAMPLE_USE_LANCZOS_TYPE: 2,
      FFX_FSR2_OPTION_REPROJECT_SAMPLERS_USE_DATA_HALF: 0,
    };
    run(path.join(tools, 'dxc'), ['-spirv', '-fspv-target-env=vulkan1.1', '-T', 'cs_6_0', '-E', 'CS', '-O3', '-fvk-t-shift', '32', '0', '-fvk-u-shift', '64', '0', '-I', shaderIncludes,
      ...Object.entries(defines).flatMap(([k, v]) => ['-D', `${fsr3?k.replace('FSR2','FSR3UPSCALER'):k}=${v}`]), path.join(shaders, `ffx_${shaderPrefix}_${passes[pass]}_pass.hlsl`), '-Fo', spv]);
    run(path.join(tools, 'spirv-cross'), [spv, '--msl', '--msl-version', '23000', '--output', metal]);
    const reflection = JSON.parse(run(path.join(tools, 'spirv-cross'), [spv, '--reflect']));
    await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(signatures(await fs.readFile(metal, 'utf8'), reflection)));
    await fs.rm(spv);
  }
}
const args = ['-std=c++17', '-O2', '-DNDEBUG', '-DFFX_GCC', `-DRS_FSR3=${fsr3?1:0}`, '-mmacosx-version-min=13.0', '-I', api,
  ...(fsr3?['-I',hostOverlay,'-I',path.join(source,'sdk/include'),'-I',path.join(source,'sdk/include/FidelityFX/host'),'-I',path.join(source,'sdk/src/shared')]:[]),
  '-include', path.join(here, 'host-compat.hpp')];
for(const arch of ['arm64','x86_64']) {
  const objects=[];
  const sources=[path.join(api,`ffx_${shaderPrefix}.cpp`),path.join(fsr3?path.join(source,'sdk/src/shared'):api,'ffx_assert.cpp'),...(fsr3?['ffx_object_management.cpp','ffx_message.cpp'].map(name=>path.join(source,'sdk/src/shared',name)):[])];
  for(const file of sources){const object=path.join(out,`${group}-${arch}-${path.basename(file)}.o`);run('xcrun',['clang++',...args,'-arch',arch,'-c',file,'-o',object]);objects.push(object);}
  run('xcrun', ['clang++', ...args, '-arch',arch, '-fobjc-arc', '-dynamiclib', path.join(here, 'backend.mm'), ...objects,
    '-framework', 'Metal', '-framework', 'Foundation', '-install_name', `@rpath/libmaclauncher-${group}.dylib`, '-o', path.join(out, `libmaclauncher-${group}-${arch}.dylib`)]);
}
const library=path.join(out,`libmaclauncher-${group}.dylib`);
run('lipo',['-create',...['arm64','x86_64'].map(arch=>path.join(out,`libmaclauncher-${group}-${arch}.dylib`)),'-output',library]);
run('codesign',['--force','--sign','-',library]);
await fs.copyFile(path.join(source, fsr3?'LICENSE.txt':'LICENSE.txt'), path.join(out, `${group.toUpperCase()}-LICENSE.txt`));
for(let variant=0;variant<16;++variant)for(let pass=0;pass<passes.length;++pass)for(const ext of ['metal','json']){
  if(!(await fs.stat(path.join(out,group,String(variant),`${pass}.${ext}`))).isFile())throw new Error('Incomplete shader resources.');
}
await fs.writeFile(path.join(out, `${group}-build.json`), JSON.stringify({ providerABI: 1, source: fsr3?'https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK':'https://github.com/GPUOpen-Effects/FidelityFX-FSR2', commit: pin, version: fsr3?'3.1.4':'2.2.1', minimumMacOS: '13.0', shaderVariants: 16 }, null, 2));
const payload=path.join(out,'payload');
await fs.mkdir(payload,{recursive:true});
await fs.cp(path.join(out,group),path.join(payload,group),{recursive:true});
for(const name of [`libmaclauncher-${group}.dylib`,`${group}-build.json`,`${group.toUpperCase()}-LICENSE.txt`])await fs.copyFile(path.join(out,name),path.join(payload,name));
const methods=[];
for(const method of ['fsr2','fsr3']){try{await fs.access(path.join(payload,`${method}-build.json`));methods.push(method);}catch{}}
await fs.writeFile(path.join(payload,'provider.json'),JSON.stringify({providerABI:1,complete:true,methods,minimumMacOS:'13.0',architectures:['arm64','x86_64'],libraries:methods.map(method=>`libmaclauncher-${method}.dylib`),shaders:methods},null,2));
console.log(`Built ${group.toUpperCase()} Metal provider: ${out}`);
