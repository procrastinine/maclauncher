// Copyright (c) MacLauncher contributors. MIT license.
// Applied only to the owned build copy after the camera/resource overlay.
export function applySnapshotOverlay(_root,replace){
 replace('src/dxmt/dxmt_texture.hpp','#include "util_svector.hpp"','#include "util_svector.hpp"\n#include "com/com_pointer.hpp"');
 replace('src/dxmt/dxmt_texture.hpp','  Texture *descriptor;\n','  Texture *descriptor;\n  Com<IUnknown> mlStreamlineSnapshotLease;\n');
 replace('src/dxmt/dxmt_texture.hpp','private:\n  void prepareAllocationViews(TextureAllocation* allocation);',`public:
  Com<IUnknown> streamlineSnapshotLease() {
    std::shared_lock<dxmt::shared_mutex> lock(mutex_);return mlStreamlineSnapshotLease_;
  }
  bool installStreamlineSnapshotLease(IUnknown *lease) {
    std::unique_lock<dxmt::shared_mutex> lock(mutex_);
    if(!lease||mlStreamlineSnapshotLease_)return false;
    mlStreamlineSnapshotLease_=lease;
    if(current_)current_->mlStreamlineSnapshotLease=mlStreamlineSnapshotLease_;
    return true;
  }
private:
  void prepareAllocationViews(TextureAllocation* allocation);`);
 replace('src/dxmt/dxmt_texture.hpp','  dxmt::shared_mutex mutex_;','  Com<IUnknown> mlStreamlineSnapshotLease_;\n  dxmt::shared_mutex mutex_;');
 replace('src/dxmt/dxmt_texture.cpp','  auto info_copy = info;','  mlStreamlineSnapshotLease=descriptor->streamlineSnapshotLease();\n  auto info_copy = info;');
 replace('src/dxmt/dxmt_texture.cpp','  mappedMemory = nullptr;','  mlStreamlineSnapshotLease=descriptor->streamlineSnapshotLease();\n  mappedMemory = nullptr;');
 replace('src/d3d11/d3d11_resource.hpp','#include "dxmt_texture.hpp"','#include "dxmt_texture.hpp"\n#include "streamline-snapshot.hpp"');
 replace('src/d3d11/d3d11_resource.hpp','    if (riid == __uuidof(IUnknown) || riid == __uuidof(ID3D11DeviceChild) ||\n        riid == __uuidof(ID3D11Resource) ||',`    if(riid==MLStreamlineSnapshotResourceGuid&&this->texture_) {
      *ppvObject=ref_and_cast<D3D11ResourceCommon>(this);return S_OK;
    }
    if (riid == __uuidof(IUnknown) || riid == __uuidof(ID3D11DeviceChild) ||
        riid == __uuidof(ID3D11Resource) ||`);
 replace('src/d3d11/d3d11_context_impl.cpp','    if (riid == __uuidof(IUnknown) || riid == __uuidof(ID3D11DeviceChild) || riid == __uuidof(ID3D11DeviceContext) ||','    if (riid == MLStreamlineSnapshotContextGuid || riid == __uuidof(IUnknown) || riid == __uuidof(ID3D11DeviceChild) || riid == __uuidof(ID3D11DeviceContext) ||');
 replace('src/d3d11/d3d11_context_impl.cpp','        // on-device copy\n        SwitchToBlitEncoder(CommandBufferState::BlitEncoderActive);\n        EmitOP([dst_ = std::move(dst), src_ = std::move(src), cmd = std::move(cmd)](ArgumentEncodingContext &enc) {\n          auto src_format = src_->pixelFormat();',`        // on-device copy
        // The native allocation, rather than only its public COM wrapper,
        // retains admission through command-list and GPU retirement.
        Com<IUnknown> mlLease;UINT mlLeaseBytes=sizeof(IUnknown*);
        if(SUCCEEDED(cmd.pDst->GetPrivateData(MLStreamlineSnapshotLeaseGuid,&mlLeaseBytes,&mlLease))&&mlLeaseBytes==sizeof(IUnknown*)&&mlLease&&dst->installStreamlineSnapshotLease(mlLease.ptr())) {
          const uint32_t recorded=1;cmd.pDst->SetPrivateData(MLStreamlineSnapshotRecordedGuid,sizeof(recorded),&recorded);
        }
        SwitchToBlitEncoder(CommandBufferState::BlitEncoderActive);
        EmitOP([dst_ = std::move(dst), src_ = std::move(src), cmd = std::move(cmd)](ArgumentEncodingContext &enc) {
          auto src_format = src_->pixelFormat();`);
}
