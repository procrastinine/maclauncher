#!/usr/bin/env node
// Exercise the pinned SDK's actual depth-constant function, including infinite
// projections, rather than checking the transport's plane ordering in isolation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const [fsr2, fsr3, output] = process.argv.slice(2).map(p => path.resolve(p));
fs.mkdirSync(output, { recursive: true });
function functionBody(file) {
  const source = fs.readFileSync(file, 'utf8');
  const begin = source.indexOf('static void setupDeviceDepthToViewSpaceDepthParams(');
  let end = source.indexOf('{', begin), depth = 1;
  while (depth && ++end < source.length) { if (source[end] === '{') ++depth; else if (source[end] === '}') --depth; }
  if (begin < 0 || depth) throw Error('SDK depth conversion function changed.');
  return source.slice(begin, end + 1);
}
const declarations = `
#include <algorithm>
#include <cassert>
#include <cfloat>
#include <cmath>
#include <cstdio>
#include "${path.join(here, 'projection.hpp')}"
#define FFX_MINIMUM std::min
#define FFX_MAXIMUM std::max
#define FFX_FSR2_ENABLE_DEPTH_INVERTED 1
#define FFX_FSR2_ENABLE_DEPTH_INFINITE 2
#define FFX_FSR3UPSCALER_ENABLE_DEPTH_INVERTED 1
#define FFX_FSR3UPSCALER_ENABLE_DEPTH_INFINITE 2
struct Context { struct { unsigned flags; } contextDescription; struct { float deviceToViewDepth[4]; } constants; };
struct Dispatch { float cameraNear,cameraFar,cameraFovAngleVertical; struct { unsigned width,height; } renderSize; };
using FfxFsr2Context_Private=Context;using FfxFsr3UpscalerContext_Private=Context;
using FfxFsr2DispatchDescription=Dispatch;using FfxFsr3UpscalerDispatchDescription=Dispatch;
`;
const body = declarations + '\nnamespace fsr2 {\n' + functionBody(path.join(fsr2, 'src/ffx-fsr2-api/ffx_fsr2.cpp')) + '\n}\nnamespace fsr3 {\n' + functionBody(path.join(fsr3, 'sdk/src/components/fsr3upscaler/ffx_fsr3upscaler.cpp')) + `
}
int main() {
  unsigned count=0;
  for(auto setup:{fsr2::setupDeviceDepthToViewSpaceDepthParams,fsr3::setupDeviceDepthToViewSpaceDepthParams})
  for(bool infinite:{false,true})for(bool reversed:{false,true}) {
    RSTemporalFrame frame{};frame.nearPlane=.3f;frame.farPlane=infinite?0:321.f;
    frame.flags=(infinite?RS_TEMPORAL_DEPTH_INFINITE:0)|(reversed?RS_TEMPORAL_DEPTH_REVERSED:0);
    Dispatch dispatch{};rsFsrCameraPlanes(frame,dispatch.cameraNear,dispatch.cameraFar);
    dispatch.cameraFovAngleVertical=1.1f;dispatch.renderSize={480,270};
    assert(reversed?dispatch.cameraNear>dispatch.cameraFar:dispatch.cameraNear<dispatch.cameraFar);
    if(infinite)assert((reversed?dispatch.cameraNear:dispatch.cameraFar)==FLT_MAX);
    Context context{};context.contextDescription.flags=(infinite?2:0)|(reversed?1:0);setup(&context,&dispatch);
    for(double distance:{.3,3.,30.}) {
      double depth=infinite?1.-frame.nearPlane/distance:321./(321.-frame.nearPlane)*(1.-frame.nearPlane/distance);
      if(reversed)depth=1.-depth;
      double reconstructed=context.constants.deviceToViewDepth[1]/(depth-context.constants.deviceToViewDepth[0]);
      if(!std::isfinite(reconstructed)||std::abs(reconstructed/distance-1)>5e-5) {
        std::fprintf(stderr,"infinite=%d reversed=%d distance=%g reconstructed=%g\\n",infinite,reversed,distance,reconstructed);return 1;
      }
      ++count;
    }
  }
  std::printf("%u upstream FSR2/3 physical depth reconstruction checks passed\\n",count);return 0;
}
`;
const source = path.join(output, 'projection-test.cpp'), binary = path.join(output, 'projection-test');
fs.writeFileSync(source, body);
execFileSync('xcrun', ['clang++', '-std=c++17', source, '-o', binary], { stdio: 'inherit' });
execFileSync(binary, [], { stdio: 'inherit' });
