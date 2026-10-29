import fs from 'node:fs';
import path from 'node:path';
import {applySnapshotOverlay} from './snapshot-overlay.mjs';

export function applyCameraOverlay(root) {
  function replace(file, before, after) {
    const name = path.join(root, file), source = fs.readFileSync(name, 'utf8');
    if (source.split(before).length !== 2) throw new Error(`DXMT source changed: ${file}`);
    fs.writeFileSync(name, source.replace(before, after));
  }
  replace('src/nvngx/nvngx.cpp', '#include <cmath>', `#include <cmath>
#include "camera-transport.hpp"
#include "streamline-transport.hpp"
namespace {
thread_local RSTemporalCamera mlCamera{};
thread_local MLStreamlineResources mlStreamline{};
thread_local MLStreamlineResourcesV2 mlStreamlineSnapshots{};
}
extern "C" __declspec(dllexport) int __cdecl MacLauncherSetTemporalCamera(const RSTemporalCamera *camera) {
  mlCamera = MLValidCamera(camera) ? *camera : RSTemporalCamera{};
  return mlCamera.size != 0;
}
extern "C" __declspec(dllexport) void __cdecl MacLauncherClearTemporalCamera() { mlCamera = {}; }
extern "C" __declspec(dllexport) int __cdecl MacLauncherSetStreamlineResourcesV1(const MLStreamlineResources *value) {
  mlStreamlineSnapshots={};
  mlStreamline=value&&value->size==sizeof(*value)&&value->version==1&&value->epoch?*value:MLStreamlineResources{};
  return mlStreamline.epoch!=0;
}
extern "C" __declspec(dllexport) void __cdecl MacLauncherClearStreamlineResourcesV1() { mlStreamline={};mlStreamlineSnapshots={}; }
extern "C" __declspec(dllexport) int __cdecl MacLauncherSetStreamlineResourcesV2(const MLStreamlineResourcesV2 *value) {
  mlStreamline={};mlStreamlineSnapshots=value&&value->size==sizeof(*value)&&value->version==2&&value->epoch?*value:MLStreamlineResourcesV2{};return mlStreamlineSnapshots.epoch!=0;
}
extern "C" __declspec(dllexport) void __cdecl MacLauncherClearStreamlineResourcesV2() { mlStreamline={};mlStreamlineSnapshots={}; }
extern "C" __declspec(dllexport) uint32_t __cdecl MacLauncherStreamlineTagSnapshotsAPI() { return 1; }`);
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
    const void *mlActiveResources=mlStreamlineSnapshots.epoch?static_cast<const void*>(&mlStreamlineSnapshots):mlStreamline.epoch?static_cast<const void*>(&mlStreamline):nullptr;
    MLScopedStreamlineResources resourcesScope(context,mlActiveResources);
    pCtxExt->TemporalUpscale(&desc);`);
  replace('src/d3d11/d3d11_context_impl.cpp', '  void STDMETHODCALLTYPE TemporalUpscale(const MTL_TEMPORAL_UPSCALE_D3D11_DESC *pDesc) final {', `  void STDMETHODCALLTYPE TemporalUpscale(const MTL_TEMPORAL_UPSCALE_D3D11_DESC *pDesc) final {
    HRESULT mlResult=E_FAIL;ctx_->SetPrivateData(MLTemporalResultGuid,sizeof(mlResult),&mlResult);
    RSTemporalCamera camera{};
    UINT cameraBytes = sizeof(camera);
    if (FAILED(ctx_->GetPrivateData(MLTemporalCameraGuid, &cameraBytes, &camera)) ||
        cameraBytes != sizeof(camera) || !MLValidCamera(&camera)) camera = {};
    MLTemporalAux auxiliary{};UINT auxiliaryBytes=sizeof(auxiliary);
    if(FAILED(ctx_->GetPrivateData(MLTemporalAuxGuid,&auxiliaryBytes,&auxiliary))||auxiliaryBytes!=sizeof(auxiliary)||auxiliary.size!=sizeof(auxiliary)||auxiliary.version!=1)auxiliary={};
    Rc<Texture> reactive;
    if(auxiliary.reactiveMask&&!(reactive=static_cast<D3D11ResourceCommon*>(auxiliary.reactiveMask)->texture()))return;`);
  const context = path.join(root, 'src/d3d11/d3d11_context_impl.cpp');
  let source = fs.readFileSync(context, 'utf8');
  const includeEnd = source.indexOf('\n', source.indexOf('#include'));
  source = source.slice(0, includeEnd + 1) + '#include "camera-transport.hpp"\n#include "streamline-transport.hpp"\n' + source.slice(includeEnd + 1);
  fs.writeFileSync(context, source);
  replace('src/d3d11/d3d11_context_impl.cpp', '                          pDesc->PreExposure,\n', '                          pDesc->PreExposure,\n                          camera,\n');
  replace('src/winemetal/winemetal.h', 'struct WMTFXTemporalScalerProps {', '#include "camera.h"\nstruct WMTFXTemporalScalerProps {');
  replace('src/winemetal/winemetal.h', '  float pre_exposure;\n};', '  float pre_exposure;\n  RSTemporalCamera camera;\n};');
  replace('src/winemetal/winemetal.h','  bool requires_synchronous_initialization;\n};','  bool requires_synchronous_initialization;\n  enum WMTPixelFormat reactive_format;\n};');
  replace('src/winemetal/winemetal.h','  RSTemporalCamera camera;\n};','  RSTemporalCamera camera;\n  obj_handle_t reactive_texture;\n};');
  replace('src/d3d11/d3d11_context_impl.cpp','    bool auto_exposure;\n    uint32_t input_width;','    bool auto_exposure;\n    bool display_motion;\n    WMTPixelFormat reactive_pixel_format;\n    uint32_t input_width;');
  replace('src/d3d11/d3d11_context_impl.cpp','      if(pDesc->AutoExposure != entry.auto_exposure) continue;','      if(pDesc->AutoExposure != entry.auto_exposure) continue;\n      if(bool(pDesc->MotionVectorInDisplayRes) != entry.display_motion) continue;\n      if((reactive?reactive->pixelFormat():WMTPixelFormatInvalid) != entry.reactive_pixel_format) continue;');
  replace('src/d3d11/d3d11_context_impl.cpp','      WMTFXTemporalScalerInfo info;','      WMTFXTemporalScalerInfo info{};\n      scaler_entry.display_motion=bool(pDesc->MotionVectorInDisplayRes);\n      scaler_entry.reactive_pixel_format=reactive?reactive->pixelFormat():WMTPixelFormatInvalid;\n      info.reactive_format=scaler_entry.reactive_pixel_format;');
  replace('src/d3d11/d3d11_context_impl.cpp','      scaler_entry.scaler = new TemporalScaler(ctx_->device->GetMTLDevice(), info);','      scaler_entry.scaler = new TemporalScaler(ctx_->device->GetMTLDevice(), info);\n      if(!scaler_entry.scaler->scaler())return;');
  replace('src/d3d11/d3d11_context_impl.cpp','      scaler_cache_.push_back(std::move(scaler_entry));','      if(scaler_cache_.size()>=8)scaler_cache_.erase(scaler_cache_.begin());\n      scaler_cache_.push_back(std::move(scaler_entry));');
  replace('src/d3d11/d3d11_context_impl.cpp','                  exposure = std::move(exposure), scaler = std::move(scaler),','                  exposure = std::move(exposure), reactive=std::move(reactive), scaler = std::move(scaler),');
  replace('src/d3d11/d3d11_context_impl.cpp','                          camera,\n','                          camera,\n                          0,\n');
  replace('src/d3d11/d3d11_context_impl.cpp','0, exposure, scaler, new_props);','0, exposure, scaler, new_props, reactive);');
  replace('src/d3d11/d3d11_context_impl.cpp','mv_view, exposure, scaler, props);','mv_view, exposure, scaler, props, reactive);');
  replace('src/d3d11/d3d11_context_impl.cpp','    });\n  }\n\n  void STDMETHODCALLTYPE BeginUAVOverlap()', '    });\n    mlResult=S_OK;ctx_->SetPrivateData(MLTemporalResultGuid,sizeof(mlResult),&mlResult);\n  }\n\n  void STDMETHODCALLTYPE BeginUAVOverlap()');
  replace('src/dxmt/dxmt_context.hpp','  WMT::Reference<WMT::Texture> exposure;\n  Rc<TemporalScaler> scaler;','  WMT::Reference<WMT::Texture> exposure;\n  WMT::Reference<WMT::Texture> reactive;\n  Rc<TemporalScaler> scaler;');
  replace('src/dxmt/dxmt_context.hpp','Rc<TemporalScaler> &scaler, const WMTFXTemporalScalerProps &props\n','Rc<TemporalScaler> &scaler, const WMTFXTemporalScalerProps &props, Rc<Texture> &reactive\n');
  replace('src/dxmt/dxmt_context.cpp','Rc<TemporalScaler> &scaler, const WMTFXTemporalScalerProps &props\n','Rc<TemporalScaler> &scaler, const WMTFXTemporalScalerProps &props, Rc<Texture> &reactive\n');
  replace('src/dxmt/dxmt_context.cpp','  encoder_info->input = access(input, input->fullView, ResourceAccess::Read).texture;\n','  if(reactive){encoder_info->reactive=access(reactive,reactive->fullView,ResourceAccess::Read).texture;encoder_info->props.reactive_texture=encoder_info->reactive.handle;}\n  encoder_info->input = access(input, input->fullView, ResourceAccess::Read).texture;\n');
  replace('src/d3d11/d3d11_context_impl.cpp','    case MTL_FEATURE_METALFX_TEMPORAL_SCALER: {',`    case MTL_FEATURE(MLTemporalReactiveFeature): {
      if(FeatureSupportDataSize!=sizeof(BOOL))return E_INVALIDARG;
      WMTFXTemporalScalerInfo info{};info.color_format=info.output_format=WMTPixelFormatRGBA16Float;info.depth_format=WMTPixelFormatDepth32Float;info.motion_format=WMTPixelFormatRG32Float;info.reactive_format=WMTPixelFormatR16Float;
      info.input_width=info.input_height=64;info.output_width=info.output_height=128;info.input_content_min_scale=1;info.input_content_max_scale=3;info.input_content_properties_enabled=true;info.requires_synchronous_initialization=true;
      auto probe=ctx_->device->GetMTLDevice().newTemporalScaler(info);*reinterpret_cast<BOOL*>(pFeatureSupportData)=bool(probe);return S_OK;
    }
    case MTL_FEATURE_METALFX_TEMPORAL_SCALER: {`);
  applyStreamlineResources(root,replace);
  applySnapshotOverlay(root,replace);
}

function applyStreamlineResources(root,replace){
  replace('src/winemetal/winemetal.h','#include "camera.h"','#include "camera.h"\n#include "streamline-native.h"');
  replace('src/winemetal/winemetal.h','  obj_handle_t reactive_texture;\n};','  obj_handle_t reactive_texture;\n  MLStreamlineNativeResources streamline;\n};');
  replace('src/d3d11/d3d11_context_impl.cpp','    Rc<Texture> input, output, depth, motion_vector, exposure;',`    Rc<Texture> input, output, depth, motion_vector, exposure;
    Rc<Texture> mlHudless,mlUI;
    MLStreamlineNativeResources mlNative{};
    MLStreamlineResourcesV2 mlTags{};UINT mlBytes=sizeof(mlTags);
    const bool mlWire=SUCCEEDED(ctx_->GetPrivateData(MLTemporalStreamlineGuid,&mlBytes,&mlTags))&&mlTags.size==mlBytes&&
      ((mlBytes==sizeof(MLStreamlineResources)&&mlTags.version==1)||(mlBytes==sizeof(mlTags)&&mlTags.version==2));
    const bool mlTagged=mlWire&&camera.size&&mlTags.frameId==camera.frameId&&mlTags.viewId==camera.viewportId&&mlTags.epoch;
    auto mlResolve=[&](unsigned slot,ID3D11Resource *expected,bool identity)->Rc<Texture>{
      const auto &image=mlTags.images[slot];if(!image.resource||image.reserved&~ML_SL_IMAGE_SNAPSHOT)return {};
      if(image.reserved&ML_SL_IMAGE_SNAPSHOT){if(mlTags.version!=2||mlTags.snapshotContexts[slot]!=static_cast<ID3D11DeviceContext*>(ctx_))return {};}
      else if(identity&&image.resource!=expected)return {};
      ID3D11Texture2D *texture=nullptr;if(FAILED(image.resource->QueryInterface(__uuidof(ID3D11Texture2D),(void**)&texture)))return {};
      ID3D11Device *device=nullptr;texture->GetDevice(&device);const bool sameDevice=device==ctx_->device;if(device)device->Release();
      D3D11_TEXTURE2D_DESC description{};texture->GetDesc(&description);
      const bool bounded=image.width&&image.height&&uint64_t(image.x)+image.width<=description.Width&&uint64_t(image.y)+image.height<=description.Height;
      Rc<Texture> resolved=sameDevice&&bounded?static_cast<D3D11ResourceCommon*>(image.resource)->texture():Rc<Texture>{};texture->Release();return resolved;
    };
    const auto &mlColor=mlTags.images[ML_SL_COLOR],&mlDepth=mlTags.images[ML_SL_DEPTH],&mlMotion=mlTags.images[ML_SL_MOTION];
    const bool mlMatched=mlTagged&&mlResolve(ML_SL_COLOR,pDesc->Color,true)&&mlResolve(ML_SL_DEPTH,pDesc->Depth,true)&&mlResolve(ML_SL_MOTION,pDesc->MotionVector,true)&&
      !mlColor.x&&!mlColor.y&&mlColor.width==pDesc->InputContentWidth&&mlColor.height==pDesc->InputContentHeight&&
      !mlDepth.x&&!mlDepth.y&&mlDepth.width==mlColor.width&&mlDepth.height==mlColor.height&&
      (!mlTags.images[ML_SL_EXPOSURE].resource||mlResolve(ML_SL_EXPOSURE,pDesc->ExposureTexture,true))&&
      (!mlTags.images[ML_SL_OUTPUT].resource||(!mlTags.images[ML_SL_OUTPUT].reserved&&mlTags.images[ML_SL_OUTPUT].resource==pDesc->Output));
    ID3D11Resource *mlInput=mlMatched&&(mlColor.reserved&ML_SL_IMAGE_SNAPSHOT)?mlColor.resource:pDesc->Color;
    ID3D11Resource *mlDepthInput=mlMatched&&(mlDepth.reserved&ML_SL_IMAGE_SNAPSHOT)?mlDepth.resource:pDesc->Depth;
    ID3D11Resource *mlMotionInput=mlMatched&&(mlMotion.reserved&ML_SL_IMAGE_SNAPSHOT)?mlMotion.resource:pDesc->MotionVector;
    ID3D11Resource *mlExposure=mlMatched&&(mlTags.images[ML_SL_EXPOSURE].reserved&ML_SL_IMAGE_SNAPSHOT)?mlTags.images[ML_SL_EXPOSURE].resource:pDesc->ExposureTexture;
    const auto &mlComposed=mlTags.images[ML_SL_COMPOSED];
    const bool mlCompleteColor=mlComposed.resource==mlInput&&mlResolve(ML_SL_COMPOSED,mlInput,true)&&mlComposed.x==mlColor.x&&mlComposed.y==mlColor.y&&mlComposed.width==mlColor.width&&mlComposed.height==mlColor.height;
    if(mlMatched&&mlCompleteColor&&mlTags.images[ML_SL_HUDLESS].resource&&mlTags.images[ML_SL_UI].resource){
      mlHudless=mlResolve(ML_SL_HUDLESS,nullptr,false);mlUI=mlResolve(ML_SL_UI,nullptr,false);
      if(mlHudless&&mlUI){mlNative.size=sizeof(mlNative);mlNative.version=1;mlNative.frameId=mlTags.frameId;mlNative.viewId=mlTags.viewId;mlNative.epoch=mlTags.epoch;mlNative.imageRevision=mlTags.imageRevision;
        const auto &h=mlTags.images[ML_SL_HUDLESS],&u=mlTags.images[ML_SL_UI];mlNative.hudless={0,h.x,h.y,h.width,h.height};mlNative.ui={0,u.x,u.y,u.width,u.height};mlNative.hudlessColor=mlTags.hudlessColor;mlNative.uiColor=mlTags.uiColor;}
    }`);
  replace('src/d3d11/d3d11_context_impl.cpp','static_cast<D3D11ResourceCommon *>(pDesc->Color)->texture()','static_cast<D3D11ResourceCommon *>(mlInput)->texture()');
  replace('src/d3d11/d3d11_context_impl.cpp','static_cast<D3D11ResourceCommon *>(pDesc->Depth)->texture()','static_cast<D3D11ResourceCommon *>(mlDepthInput)->texture()');
  replace('src/d3d11/d3d11_context_impl.cpp','static_cast<D3D11ResourceCommon *>(pDesc->MotionVector)->texture()','static_cast<D3D11ResourceCommon *>(mlMotionInput)->texture()');
  replace('src/d3d11/d3d11_context_impl.cpp','pDesc->ExposureTexture && !(exposure = static_cast<D3D11ResourceCommon *>(pDesc->ExposureTexture)->texture())','mlExposure && !(exposure = static_cast<D3D11ResourceCommon *>(mlExposure)->texture())');
  replace('src/d3d11/d3d11_context_impl.cpp','                  exposure = std::move(exposure), reactive=std::move(reactive), scaler = std::move(scaler),','                  exposure = std::move(exposure), reactive=std::move(reactive), mlHudless=std::move(mlHudless),mlUI=std::move(mlUI),mlNative, scaler = std::move(scaler),');
  replace('src/d3d11/d3d11_context_impl.cpp','0, exposure, scaler, new_props, reactive);','0, exposure, scaler, new_props, reactive, mlHudless, mlUI, mlNative);');
  replace('src/d3d11/d3d11_context_impl.cpp','mv_view, exposure, scaler, props, reactive);','mv_view, exposure, scaler, props, reactive, mlHudless, mlUI, mlNative);');
  for(const file of ['src/dxmt/dxmt_context.hpp','src/dxmt/dxmt_context.cpp'])replace(file,'const WMTFXTemporalScalerProps &props, Rc<Texture> &reactive\n','const WMTFXTemporalScalerProps &props, Rc<Texture> &reactive, Rc<Texture> &hudless, Rc<Texture> &ui, const MLStreamlineNativeResources &streamline\n');
  replace('src/dxmt/dxmt_context.hpp','  WMT::Reference<WMT::Texture> reactive;','  WMT::Reference<WMT::Texture> reactive;\n  WMT::Reference<WMT::Texture> ml_hudless,ml_ui;');
  replace('src/dxmt/dxmt_context.cpp','  encoder_info->input = access(input, input->fullView, ResourceAccess::Read).texture;',`  if(streamline.size==sizeof(streamline)&&streamline.version==1&&hudless&&ui){
    encoder_info->ml_hudless=access(hudless,hudless->fullView,ResourceAccess::Read).texture;
    encoder_info->ml_ui=access(ui,ui->fullView,ResourceAccess::Read).texture;
    encoder_info->props.streamline=streamline;encoder_info->props.streamline.hudless.texture=encoder_info->ml_hudless.handle;encoder_info->props.streamline.ui.texture=encoder_info->ml_ui.handle;
  }
  encoder_info->input = access(input, input->fullView, ResourceAccess::Read).texture;`);
}
