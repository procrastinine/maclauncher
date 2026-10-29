#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "camera-transport.hpp"
#include "image-color.h"
#include "streamline-snapshot.hpp"

// This is an owned, additive D3D11 side channel. Its resources are COM objects
// only in the PE half; the DXMT recording boundary resolves native textures.
inline constexpr GUID MLTemporalStreamlineGuid={0x7ace5da4,0xe89b,0x46ed,{0x92,0x94,0x51,0x40,0x6b,0x3a,0x01,0x21}};
enum MLStreamlineSlot {ML_SL_COLOR,ML_SL_DEPTH,ML_SL_MOTION,ML_SL_EXPOSURE,ML_SL_OUTPUT,ML_SL_HUDLESS,ML_SL_UI,ML_SL_COMPOSED,ML_SL_COUNT};
struct MLStreamlineImage {ID3D11Resource *resource=nullptr;uint32_t x=0,y=0,width=0,height=0,format=0,reserved=0;};
struct MLStreamlineResources {
  uint32_t size=sizeof(MLStreamlineResources),version=1;
  uint64_t frameId=0,viewId=0,epoch=0,imageRevision=0;
  MLStreamlineImage images[ML_SL_COUNT]{};
  RSImageColorDescription hudlessColor{},uiColor{};
};
static_assert(sizeof(MLStreamlineImage)==32&&sizeof(MLStreamlineResources)==392,"Streamline D3D11 resource carrier ABI1 changed");
inline constexpr uint32_t ML_SL_IMAGE_SNAPSHOT=1;
// ABI1 remains accepted for retained resources. ABI2 adds the actual tag-call
// recording context for immutable OnlyValidNow input snapshots.
struct MLStreamlineResourcesV2 {
  uint32_t size=sizeof(MLStreamlineResourcesV2),version=2;
  uint64_t frameId=0,viewId=0,epoch=0,imageRevision=0;
  MLStreamlineImage images[ML_SL_COUNT]{};
  RSImageColorDescription hudlessColor{},uiColor{};
  ID3D11DeviceContext *snapshotContexts[ML_SL_COUNT]{};
};
static_assert(sizeof(MLStreamlineResourcesV2)==456&&offsetof(MLStreamlineResourcesV2,snapshotContexts)==sizeof(MLStreamlineResources),"Streamline snapshot carrier ABI2 changed");
// Owns only the synchronous private-data scope. DXMT takes real texture
// references before queuing its command, so no raw COM pointer is queued.
struct MLScopedStreamlineResources {
  ID3D11DeviceContext *context;MLStreamlineResourcesV2 previous{};UINT previousBytes=0;
  MLScopedStreamlineResources(ID3D11DeviceContext *context,const void *value):context(context){
    UINT bytes=sizeof(previous);if(SUCCEEDED(context->GetPrivateData(MLTemporalStreamlineGuid,&bytes,&previous))&&
      ((bytes==sizeof(MLStreamlineResources)&&previous.size==bytes&&previous.version==1)||(bytes==sizeof(previous)&&previous.size==bytes&&previous.version==2)))previousBytes=bytes;
    const auto *header=static_cast<const MLStreamlineResources*>(value);UINT count=header&&((header->version==1&&header->size==sizeof(MLStreamlineResources))||(header->version==2&&header->size==sizeof(MLStreamlineResourcesV2)))?header->size:0;
    context->SetPrivateData(MLTemporalStreamlineGuid,count,count?value:nullptr);
  }
  ~MLScopedStreamlineResources(){context->SetPrivateData(MLTemporalStreamlineGuid,previousBytes,previousBytes?&previous:nullptr);}
};
