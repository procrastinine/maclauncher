#!/usr/bin/env node
// Copyright (c) MacLauncher contributors. MIT license.
// Original FidelityFX CACAO kernels and constant/scheduling contract.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here = import.meta.dirname,
      spec = JSON.parse(fs.readFileSync(path.join(here, 'source.json'))),
      options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--source', '--tools', '--output'].includes(process.argv[i]) ||
      !process.argv[i + 1] || options[process.argv[i]])
    throw Error('Expected unique --source, --tools, --output paths.');
  options[process.argv[i]] = path.resolve(process.argv[i + 1]);
}
for (const n of ['--source', '--tools', '--output'])
  if (!options[n])
    throw Error('Missing ' + n);
const source = options['--source'], tools = options['--tools'],
      out = options['--output'],
      hash = b => crypto.createHash('sha256').update(b).digest('hex'),
      run = (exe, args) => execFileSync(
          exe, args, {encoding : 'utf8', maxBuffer : 32 * 1024 * 1024});
if (run('git', [ '-C', source, 'rev-parse', 'HEAD' ]).trim() !== spec.commit)
  throw Error('CACAO source pin changed.');
run('git', [ '-C', source, 'diff', '--exit-code', 'HEAD', '--' ]);
const read = file =>
    fs.existsSync(path.join(source, file))
        ? fs.readFileSync(path.join(source, file), 'utf8')
        : run('git', [ '-C', source, 'show', spec.commit + ':' + file ]);
for (const [file, digest] of Object.entries(spec.files))
  if (hash(read(file)) !== digest)
    throw Error('CACAO source changed: ' + file);
fs.mkdirSync(out, {recursive : true});
const overlay = path.join(out, 'overlay'),
      gpu = path.join(source, 'sdk/include/FidelityFX/gpu');
fs.mkdirSync(path.join(overlay, 'cacao'), {recursive : true});
for (const name of fs.readdirSync(path.join(gpu, 'cacao')))
  if (name.endsWith('.h'))
    fs.copyFileSync(path.join(gpu, 'cacao', name),
                    path.join(overlay, 'cacao', name));
fs.copyFileSync(path.join(here, '../native/scene-projection.hlsl'),
                path.join(overlay, 'scene-projection.hlsl'));
function patched(file, transform) {
  const original = read('sdk/include/FidelityFX/gpu/cacao/' + file);
  let text = original;
  const replace = (before, after, count = 1) => {
    if (text.split(before).length !== count + 1)
      throw Error('CACAO adaptation changed: ' + before.slice(0, 100));
    text = text.split(before).join(after);
  };
  transform(replace);
  fs.writeFileSync(path.join(overlay, 'cacao', file), text);
  return {sourceSha256 : hash(original), appliedSha256 : hash(text)};
}
const adaptations = {};
adaptations.callbacks = patched('ffx_cacao_callbacks_hlsl.h', replace => {
  replace('RWTexture2D<FfxFloat32x4>                     g_RwOutput',
          'RWTexture2D<FfxFloat32>                       g_RwOutput');
  replace('g_RwOutput[coord].r = val;', 'g_RwOutput[coord] = val;');
  replace('g_RwOutput[coord + offset].r = val;',
          'g_RwOutput[coord + offset] = val;');

  replace('RWTexture1D<FfxUInt32>', 'RWStructuredBuffer<FfxUInt32>');
  replace('Texture1D<FfxUInt32>', 'StructuredBuffer<FfxUInt32>');
  const declaration =
      'RWTexture2DArray<FfxFloat32>                  g_RwDepthMips[4]                    : FFX_CACAO_DECLARE_UAV(FFX_CACAO_RESOURCE_IDENTIFIER_DOWNSAMPLED_DEPTH_MIPMAP_0);';
  replace(declaration,
          Array
              .from({length : 4},
                    (_, i) => `RWTexture2DArray<FfxFloat32> g_RwDepthMip${
                        i} : register(u${12 + i});`)
              .join('\n'));
  for (let i = 0; i < 4; i++)
    replace('g_RwDepthMips[' + i + ']', 'g_RwDepthMip' + i);
  replace(
      'return g_DepthIn.Load(FfxInt32x3(coord, 0));',
      'return g_DepthIn.Load(FfxInt32x3(clamp(FfxInt32x2(coord),FfxInt32x2(0,0),FfxInt32x2(DepthBufferDimensions())-1),0));');
  replace(
      'return g_DepthIn.Load(FfxInt32x3(coord, 0), offset);',
      'return g_DepthIn.Load(FfxInt32x3(clamp(FfxInt32x2(coord)+offset,FfxInt32x2(0,0),FfxInt32x2(DepthBufferDimensions())-1),0));');

  replace(
      'return g_SsaoBufferPing.Load(FfxInt32x4(coord, index, 0));',
      'return g_SsaoBufferPing.Load(FfxInt32x4(clamp(FfxInt32x2(coord),FfxInt32x2(0,0),FfxInt32x2(SSAOBufferDimensions())-1),index,0));');
  replace(
      'return g_DeinterleavedDepth.Load(FfxInt32x4(coord, index, 0));',
      'return g_DeinterleavedDepth.Load(FfxInt32x4(clamp(FfxInt32x2(coord),FfxInt32x2(0,0),FfxInt32x2(DeinterleavedDepthBufferDimensions())-1),index,0));');
  for (const [x, y] of [[ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ]])
    replace('g_DepthIn.Load(FfxInt32x3(coord, 0), FfxInt32x2(' + x + ', ' + y +
                '))',
            'FFX_CACAO_Prepare_LoadDepthOffset(coord,FfxInt32x2(' + x + ',' +
                y + '))');
});
adaptations.upscaleBoundary = patched('ffx_cacao_upscale.h', replace => {
  replace(
      'FfxUInt32x2 imageCoord = (gid * FfxUInt32x2(FFX_CACAO_BILATERAL_UPSCALE_WIDTH, FFX_CACAO_BILATERAL_UPSCALE_HEIGHT)) + bufferCoord - 2;',
      'FfxInt32x2 imageCoord = FfxInt32x2((gid * FfxUInt32x2(FFX_CACAO_BILATERAL_UPSCALE_WIDTH, FFX_CACAO_BILATERAL_UPSCALE_HEIGHT)) + bufferCoord) - 2;',
      3);
  replace('p / 2', 'p >> 1');
  for (const axis of ['x', 'y']) {
    replace('p.' + axis + ' % 2', '(p.' + axis + ' & 1)');
  }
  // All three upscaler kernels have the same signed tile halo. Preserve its
  // floor division and even/odd layer identity across negative coordinates.
  const original = read('sdk/include/FidelityFX/gpu/cacao/ffx_cacao_upscale.h');
  for (const [from, to] of [[ 'imageCoord / 2', 'imageCoord >> 1' ],
                            [ 'imageCoord.x % 2', '(imageCoord.x & 1)' ],
                            [ 'imageCoord.y % 2', '(imageCoord.y & 1)' ]])
    replace(from, to, original.split(from).length - 1);
});
adaptations.geometry = patched('ffx_cacao_utils.h', replace => {
  replace(
      'return depthLinearizeMul * ffxInvertSafe(depthLinearizeAdd - screenDepth);',
      'return screenDepth; // Canonical GPU depth ingress already used the actual projection.',
      2);
  const ndc =
      'FfxFloat32x3 ret;\n\n\tret.xy = (NDCToViewMul() * pos.xy + NDCToViewAdd()) * viewspaceDepth;\n\n\tret.z = viewspaceDepth;\n\n\treturn ret;';
  replace(ndc, 'return mlPosition(pos,viewspaceDepth);');
  replace(
      'FfxFloat32x3 ret;\n\tret.xy = (DepthBufferUVToViewMul() * pos.xy + DepthBufferUVToViewAdd()) * viewspaceDepth;\n\tret.z = viewspaceDepth;\n\treturn ret;',
      'return mlPosition(pos,viewspaceDepth);');
});
adaptations.generation = patched('ffx_cacao_ssao_generation.h', replace => {
  replace(
      'const FfxFloat32 tooCloseLimitMod = ffxSaturate(pixCenterLength * EffectSamplingRadiusNearLimitRec()) * 0.8 + 0.2;',
      'const FfxFloat32 tooCloseLimitMod = (uint(mlClip.w)&2)!=0?1.0:ffxSaturate(pixCenterLength * EffectSamplingRadiusNearLimitRec()) * 0.8 + 0.2;');
  replace(
      'const FfxFloat32x2 pixelDirRBViewspaceSizeAtCenterZ = pixCenterPos.z * NDCToViewMul() * SSAOBufferInverseDimensions();',
      'const FfxFloat32x2 pixelDirRBViewspaceSizeAtCenterZ = float2(length(mlPosition(normalizedScreenPos+float2(SSAOBufferInverseDimensions().x,0),pixCenterPos.z)-pixCenterPos),-length(mlPosition(normalizedScreenPos+float2(0,SSAOBufferInverseDimensions().y),pixCenterPos.z)-pixCenterPos));');
  replace(
      'pixCenterPos *= DepthPrecisionOffsetMod();',
      'pixCenterPos = mlPosition(normalizedScreenPos,pixCenterPos.z*DepthPrecisionOffsetMod());');
  for (const [side, coord,
              z] of [[ 'L', '-SSAOBufferInverseDimensions().x,0', 'pixLZ' ],
                     [ 'R', 'SSAOBufferInverseDimensions().x,0', 'pixRZ' ],
                     [ 'T', '0,-SSAOBufferInverseDimensions().y', 'pixTZ' ],
                     [ 'B', '0,SSAOBufferInverseDimensions().y', 'pixBZ' ]]) {
    const original = read(
              'sdk/include/FidelityFX/gpu/cacao/ffx_cacao_ssao_generation.h'),
          line = original.split('\n').find(
              l => l.includes('FfxFloat32x3 pix' + side + 'Delta ='));
    if (!line)
      throw Error('CACAO detail geometry changed.');
    replace(line.trim(), 'FfxFloat32x3 pix' + side +
                             'Delta = mlPosition(normalizedScreenPos+float2(' +
                             coord + '),' + z + ')-pixCenterPos;');
  }
});
// Exact original public CPU constant structures and tuning functions. Backend
// object management is independent and stays in the native ShaderNode owner.
const host = read('sdk/include/FidelityFX/host/ffx_cacao.h'),
      cpp = read('sdk/src/components/cacao/ffx_cacao.cpp');
function typedef(name, kind = 'struct') {
  const re =
      new RegExp('typedef ' + kind + ' ' + name + '[\\s\\S]*?} ' + name + ';');
  const m = re.exec(host);
  if (!m)
    throw Error('CACAO host declaration changed: ' + name);
  return m[0];
}
const
    defaults =
        /static const FfxCacaoSettings FFX_CACAO_DEFAULT_SETTINGS = \{[\s\S]*?\n};/
            .exec(host),
    start = cpp.indexOf('void ffxCacaoUpdateBufferSizeInfo('),
    end = cpp.indexOf(
        '// =================================================================================\n// Interface',
        start);
if (!defaults || start < 0 || end < 0)
  throw Error('CACAO constants implementation changed.');
const identity =
    /static const FfxFloat32x4x4 FFX_CACAO_IDENTITY_MATRIX = \{[\s\S]*?\n};/
        .exec(cpp);
if (!identity)
  throw Error('CACAO identity for generated view-space normals changed.');
let h =
    '// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see cacao-MIT.txt.\n// Exact declarations and constant functions from the pinned original CACAO.\n#pragma once\n#include <cmath>\n#include <cstdint>\n#include <cstring>\nnamespace macfx::cacao_host {\nusing FfxFloat32x4x4=float[16];\n' +
    typedef('FfxCacaoQuality', 'enum') + '\n' + typedef('FfxCacaoSettings') +
    '\n' + defaults[0] + '\n' + typedef('FfxCacaoConstants') + '\n' +
    typedef('FfxCacaoBufferSizeInfo') + '\n' + identity[0] + '\n';
h +=
    '#define FFX_CACAO_ARRAY_SIZE(xs) (sizeof(xs)/sizeof(xs[0]))\n#define FFX_CACAO_COS cosf\n#define FFX_CACAO_SIN sinf\n#define FFX_CACAO_MIN(x,y) (((x)<(y))?(x):(y))\n#define FFX_CACAO_MAX(x,y) (((x)>(y))?(x):(y))\n#define FFX_CACAO_CLAMP(x,a,b) FFX_CACAO_MIN(FFX_CACAO_MAX(x,a),b)\n#define MATRIX_ROW_MAJOR_ORDER 1\n';
h +=
    cpp.slice(start, end) +
    '\n#undef FFX_CACAO_ARRAY_SIZE\n#undef FFX_CACAO_COS\n#undef FFX_CACAO_SIN\n#undef FFX_CACAO_MIN\n#undef FFX_CACAO_MAX\n#undef FFX_CACAO_CLAMP\n#undef MATRIX_ROW_MAJOR_ORDER\n}\n';
fs.writeFileSync(path.join(out, 'cacao-upstream.hpp'), h);
const shaders = [];
for (const role of spec.roles) {
  const base = path.join(out, role.name), spv = base + '.spv',
        metal = base + '.metal';
  let input, entry = 'CS';
  if (role.file) {
    let text = read(role.file);
    const anchor = '#include "cacao/ffx_cacao_callbacks_hlsl.h"';
    if (text.split(anchor).length !== 2)
      throw Error('CACAO wrapper boundary changed.');
    text = text.replace(anchor, anchor + '\n#include "scene-projection.hlsl"');
    input = base + '.hlsl';
    fs.writeFileSync(input, text);
  } else {
    input = path.join(here, 'boundary.hlsl');
    entry = role.entry;
  }
  const d = {
    FFX_GPU : 1,
    FFX_HLSL : 1,
    FFX_HLSL_6_2 : 1,
    FFX_HALF : role.half ? 1 : 0,
    FFX_CACAO_OPTION_APPLY_SMART : role.smart ? 1 : 0
  };
  run(path.join(tools, 'dxc'), [
    '-spirv',
    '-fspv-target-env=vulkan1.1spirv1.4',
    '-T',
    'cs_6_2',
    '-E',
    entry,
    '-O3',
    ...(role.half ? [ '-enable-16bit-types' ] : []),
    '-fvk-t-shift',
    '32',
    '0',
    '-fvk-u-shift',
    '64',
    '0',
    '-I',
    overlay,
    '-I',
    path.join(overlay, 'cacao'),
    '-I',
    gpu,
    '-I',
    path.join(gpu, 'cacao'),
    ...Object.entries(d).flatMap(([ k, v ]) => ['-D', k + '=' + v]),
    input,
    '-Fo',
    spv
  ]);
  run(path.join(tools, 'spirv-val'),
      [ '--target-env', 'vulkan1.1spv1.4', spv ]);
  run(path.join(tools, 'spirv-cross'),
      [ spv, '--msl', '--msl-version', '23000', '--output', metal ]);
  const reflection = JSON.parse(
            run(path.join(tools, 'spirv-cross'), [ spv, '--reflect' ])),
        msl = fs.readFileSync(metal, 'utf8'),
        kernel = /kernel\s+\w+\s+(\w+)\s*\(([\s\S]*?)\)\s*\{/.exec(msl);
  if (!kernel)
    throw Error('CACAO kernel entry unavailable.');
  const bindings = [
    ...kernel[2].matchAll(/(\w+)\s*\[\[(buffer|texture|sampler)\((\d+)\)\]\]/g)
  ].map(m => ({name : m[1], kind : m[2], index : Number(m[3])}));
  shaders.push({
    name : role.name,
    entry : kernel[1],
    threads : reflection.entryPoints[0].workgroup_size,
    bindings,
    sha256 : hash(msl),
    source : msl
  });
  fs.rmSync(spv);
}
let header =
    '// Copyright (C) 2024 Advanced Micro Devices, Inc. MIT; see cacao-MIT.txt.\n// Generated original CACAO compute pipeline.\n#pragma once\n#include <cstddef>\nnamespace macfx::cacao_shaders {\nstruct Binding{const char*name;const char*kind;unsigned index;};\nstruct Shader{const char*name;const char*entry;const char*source;const Binding*bindings;size_t count;unsigned x,y,z;};\n';
shaders.forEach((s, i) => {
  header += `inline constexpr Binding bindings${i}[]={${
      s.bindings
          .map(b => '{' + JSON.stringify(b.name) + ',' +
                    JSON.stringify(b.kind) + ',' + b.index + '}')
          .join(',')}};\ninline constexpr const char*source${i}=R"CACAO_GPU(${
      s.source})CACAO_GPU";\n`;
});
header += 'inline constexpr Shader shaders[]={';
shaders.forEach(
    (s, i) => header +=
    `{${JSON.stringify(s.name)},${JSON.stringify(s.entry)},source${i},bindings${
        i},sizeof(bindings${i})/sizeof(Binding),${s.threads.join(',')}},`);
header += '};\n}\n';
fs.writeFileSync(path.join(out, 'cacao-shaders.hpp'), header);
fs.writeFileSync(path.join(out, 'cacao-MIT.txt'), read('LICENSE.txt'));
fs.writeFileSync(path.join(out, 'translation.json'), JSON.stringify({
  schema : 1,
  repository : spec.repository,
  commit : spec.commit,
  license : spec.license,
  source : spec,
  owned : hash(fs.readFileSync(import.meta.filename)),
  ownedFiles : Object.fromEntries([
    'boundary.hlsl', '../native/scene-projection.hlsl'
  ].map(n => [n, hash(fs.readFileSync(path.join(here, n)))])),
  adaptations,
  geometry : {
    actualInverseProjection : true,
    explicitClipJitterYConventions : true,
    perspectiveAndOrthographic : true,
    canonicalDepthROI : true
  },
  hostHeaderSha256 : hash(h),
  headerSha256 : hash(header),
  shaders : shaders.map(({source, ...s}) => s),
  tools : Object.fromEntries([ 'dxc', 'spirv-cross', 'spirv-val' ].map(
      n => [n, hash(fs.readFileSync(path.join(tools, n)))]))
},
                                                                    null, 2) +
                                                         '\n');
console.log('Translated original CACAO GPU pipeline: ' + out);
