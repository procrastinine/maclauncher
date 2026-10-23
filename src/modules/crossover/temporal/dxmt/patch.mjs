import fs from 'node:fs';
import path from 'node:path';

export function applyCameraOverlay(root) {
  function replace(file, before, after) {
    const name = path.join(root, file), source = fs.readFileSync(name, 'utf8');
    if (source.split(before).length !== 2) throw new Error(`DXMT source changed: ${file}`);
    fs.writeFileSync(name, source.replace(before, after));
  }
  replace('src/nvngx/nvngx.cpp', '#include <cmath>', `#include <cmath>
#include "camera-transport.hpp"
namespace {
thread_local RSTemporalCamera mlCamera{};
}
extern "C" __declspec(dllexport) int __cdecl MacLauncherSetTemporalCamera(const RSTemporalCamera *camera) {
  mlCamera = MLValidCamera(camera) ? *camera : RSTemporalCamera{};
  return mlCamera.size != 0;
}
extern "C" __declspec(dllexport) void __cdecl MacLauncherClearTemporalCamera() { mlCamera = {}; }`);
  replace('src/nvngx/nvngx.cpp', '    pCtxExt->TemporalUpscale(&desc);', `    RSTemporalCamera camera = mlCamera;
    if (camera.size) {
      camera.flags &= ~(RS_TEMPORAL_HDR | RS_TEMPORAL_DEPTH_REVERSED |
          RS_TEMPORAL_JITTERED_MOTION | RS_TEMPORAL_OUTPUT_MOTION);
      if (dlss->flag & 1) camera.flags |= RS_TEMPORAL_HDR;
      if (desc.DepthReversed) camera.flags |= RS_TEMPORAL_DEPTH_REVERSED;
      if (dlss->flag & NVNGX_DLSS_FLAG_MV_JITTERED) camera.flags |= RS_TEMPORAL_JITTERED_MOTION;
      // DXMT downsamples display-resolution motion to render resolution before
      // encoding; its forwarded motion texture is therefore always low resolution.
      if (reset) camera.flags |= RS_TEMPORAL_RESET;
      float delta = 0;
      if (parameters->Get("FrameTimeDeltaInMsec", &delta) == NVNGX_RESULT_OK &&
          std::isfinite(delta) && delta > 0) camera.frameTimeMs = delta;
    }
    MLScopedContextCamera cameraScope(context, camera.size ? &camera : nullptr);
    pCtxExt->TemporalUpscale(&desc);`);
  replace('src/d3d11/d3d11_context_impl.cpp', '  void STDMETHODCALLTYPE TemporalUpscale(const MTL_TEMPORAL_UPSCALE_D3D11_DESC *pDesc) final {', `  void STDMETHODCALLTYPE TemporalUpscale(const MTL_TEMPORAL_UPSCALE_D3D11_DESC *pDesc) final {
    RSTemporalCamera camera{};
    UINT cameraBytes = sizeof(camera);
    if (FAILED(ctx_->GetPrivateData(MLTemporalCameraGuid, &cameraBytes, &camera)) ||
        cameraBytes != sizeof(camera) || !MLValidCamera(&camera)) camera = {};`);
  const context = path.join(root, 'src/d3d11/d3d11_context_impl.cpp');
  let source = fs.readFileSync(context, 'utf8');
  const includeEnd = source.indexOf('\n', source.indexOf('#include'));
  source = source.slice(0, includeEnd + 1) + '#include "camera-transport.hpp"\n' + source.slice(includeEnd + 1);
  fs.writeFileSync(context, source);
  replace('src/d3d11/d3d11_context_impl.cpp', '                          pDesc->PreExposure,\n', '                          pDesc->PreExposure,\n                          camera,\n');
  replace('src/winemetal/winemetal.h', 'struct WMTFXTemporalScalerProps {', '#include "camera.h"\nstruct WMTFXTemporalScalerProps {');
  replace('src/winemetal/winemetal.h', '  float pre_exposure;\n};', '  float pre_exposure;\n  RSTemporalCamera camera;\n};');
}
