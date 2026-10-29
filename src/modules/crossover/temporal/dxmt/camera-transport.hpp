#pragma once
#include "camera.h"
#include "frame.h"
#include <d3d11.h>
#include <cmath>

// Private data is copied synchronously by TemporalUpscale before DXMT queues it.
// This keeps the public context extension vtable and descriptor ABI unchanged.
inline constexpr GUID MLTemporalCameraGuid = {
    0x7ace5da1, 0xe89b, 0x46ed, {0x92, 0x94, 0x51, 0x40, 0x6b, 0x3a, 0x01, 0x21}};
inline constexpr GUID MLTemporalAuxGuid = {
    0x7ace5da2, 0xe89b, 0x46ed, {0x92, 0x94, 0x51, 0x40, 0x6b, 0x3a, 0x01, 0x21}};
inline constexpr GUID MLTemporalResultGuid = {
    0x7ace5da3, 0xe89b, 0x46ed, {0x92, 0x94, 0x51, 0x40, 0x6b, 0x3a, 0x01, 0x21}};
// Feature 1 is unused by the exact selected DXMT interface; its original enum
// ABI permits this value. Older adapters return E_INVALIDARG for this query.
inline constexpr uint32_t MLTemporalReactiveFeature=1;
struct MLTemporalAux {uint32_t size=sizeof(MLTemporalAux),version=1;ID3D11Resource *reactiveMask=nullptr;};
struct MLScopedContextAux {
  ID3D11DeviceContext *context;MLTemporalAux previous{};bool hadPrevious=false;
  MLScopedContextAux(ID3D11DeviceContext *context,const MLTemporalAux &aux):context(context){UINT bytes=sizeof(previous);hadPrevious=SUCCEEDED(context->GetPrivateData(MLTemporalAuxGuid,&bytes,&previous))&&bytes==sizeof(previous)&&previous.size==sizeof(previous)&&previous.version==1;context->SetPrivateData(MLTemporalAuxGuid,sizeof(aux),&aux);}
  ~MLScopedContextAux(){context->SetPrivateData(MLTemporalAuxGuid,hadPrevious?sizeof(previous):0,hadPrevious?&previous:nullptr);}
};

inline bool MLValidCamera(const RSTemporalCamera *p) {
  constexpr uint32_t flags = RS_TEMPORAL_RESET | RS_TEMPORAL_DEPTH_REVERSED |
      RS_TEMPORAL_DEPTH_INFINITE | RS_TEMPORAL_HDR | RS_TEMPORAL_JITTERED_MOTION |
      RS_TEMPORAL_OUTPUT_MOTION;
  if (!p || p->size != sizeof(*p) || p->version != 1 || p->reserved ||
      (p->flags & ~flags) || !p->frameId || !std::isfinite(p->nearPlane) ||
      p->nearPlane <= 0 || !std::isfinite(p->verticalFov) ||
      p->verticalFov <= 0 || p->verticalFov >= 3.14159265358979323846f ||
      !std::isfinite(p->frameTimeMs) || p->frameTimeMs < 0)
    return false;
  for (auto reserved : p->reserved2) if (reserved) return false;
  return p->flags & RS_TEMPORAL_DEPTH_INFINITE ? p->farPlane == 0 :
      std::isfinite(p->farPlane) && p->farPlane > p->nearPlane;
}

struct MLScopedContextCamera {
  ID3D11DeviceContext *context;
  RSTemporalCamera previous{};
  bool hadPrevious = false;
  MLScopedContextCamera(ID3D11DeviceContext *context, const RSTemporalCamera *camera) : context(context) {
    UINT bytes = sizeof(previous);
    hadPrevious = SUCCEEDED(context->GetPrivateData(MLTemporalCameraGuid, &bytes, &previous)) &&
        bytes == sizeof(previous) && MLValidCamera(&previous);
    context->SetPrivateData(MLTemporalCameraGuid, camera ? sizeof(*camera) : 0, camera);
  }
  ~MLScopedContextCamera() {
    context->SetPrivateData(MLTemporalCameraGuid, hadPrevious ? sizeof(previous) : 0,
        hadPrevious ? &previous : nullptr);
  }
};
