#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <array>
#include <mutex>
#include <d3d11.h>
#include <wrl/client.h>
#include <sl_core_types.h>
#include "../dxmt/streamline-transport.hpp"
#include "snapshots.hpp"

namespace maclauncher_streamline {
using Microsoft::WRL::ComPtr;
inline int resourceSlot(sl::BufferType type){
  if(type==sl::kBufferTypeScalingInputColor)return ML_SL_COLOR;
  if(type==sl::kBufferTypeDepth)return ML_SL_DEPTH;
  if(type==sl::kBufferTypeMotionVectors)return ML_SL_MOTION;
  if(type==sl::kBufferTypeExposure)return ML_SL_EXPOSURE;
  if(type==sl::kBufferTypeScalingOutputColor)return ML_SL_OUTPUT;
  if(type==sl::kBufferTypeHUDLessColor)return ML_SL_HUDLESS;
  if(type==sl::kBufferTypeUIColorAndAlpha)return ML_SL_UI;
  if(type==sl::kBufferTypeBackbuffer)return ML_SL_COMPOSED;
  return -1;
}
struct TaggedImage {
  bool supplied=false;
  ComPtr<ID3D11Texture2D> texture;
  sl::Extent extent{};DXGI_FORMAT format=DXGI_FORMAT_UNKNOWN;
  bool snapshot=false;ComPtr<ID3D11DeviceContext> recording;
};
struct TaggedFrame {
  uint64_t age=0,epoch=0,revision=0;uint32_t frame=0,view=0;bool framed=false;
  std::array<TaggedImage,ML_SL_COUNT> images{};
};
struct TaggedBatch {uint64_t epoch=0;bool valid=true,reset=false;std::array<TaggedImage,ML_SL_COUNT>images{};};
inline TaggedImage taggedImage(const sl::ResourceTag &tag,ID3D11Device *device,SnapshotSession*session=nullptr){
  TaggedImage result;result.supplied=true;
  if(!device||tag.structType!=sl::ResourceTag::s_structType||tag.structVersion!=1||!tag.resource)return result;
  auto extension=tag.next;unsigned links=0;
  while(extension&&links++<32){
    if(extension->structType==sl::PrecisionInfo::s_structType){const auto &precision=*static_cast<const sl::PrecisionInfo*>(extension);
      if(precision.structVersion!=1||precision.conversionFormula!=sl::PrecisionInfo::eNoTransform)return result;}
    extension=extension->next;
  }
  if(extension)return result;
  if(tag.lifecycle!=sl::eValidUntilEvaluate&&tag.lifecycle!=sl::eValidUntilPresent&&tag.lifecycle!=sl::eOnlyValidNow)return result;
  const auto &resource=*tag.resource;
  if(resource.structType!=sl::Resource::s_structType||resource.structVersion!=1||resource.type!=sl::ResourceType::eTex2d||!resource.native)return result;
  // The profile is established through slSetD3DDevice, not guessed from an
  // opaque resource pointer. QueryInterface is used only on that D3D11 profile.
  ComPtr<ID3D11Texture2D> texture;
  if(FAILED(static_cast<IUnknown*>(resource.native)->QueryInterface(IID_PPV_ARGS(&texture))))return result;
  ComPtr<ID3D11Device> owner;texture->GetDevice(&owner);if(owner.Get()!=device)return result;
  D3D11_TEXTURE2D_DESC description{};texture->GetDesc(&description);
  if(!description.Width||!description.Height||description.ArraySize!=1||description.SampleDesc.Count!=1)return result;
  auto extent=tag.extent;
  if(!extent.width&&!extent.height&&!extent.left&&!extent.top)extent={0,0,description.Width,description.Height};
  if(!extent.width||!extent.height||uint64_t(extent.left)+extent.width>description.Width||uint64_t(extent.top)+extent.height>description.Height)return result;
  if(tag.lifecycle==sl::eOnlyValidNow){
    // A writable output remains the original SDK's target. Its earlier pixels
    // are not an input snapshot and its invalid borrowed pointer is not saved.
    if(!session||tag.type==sl::kBufferTypeScalingOutputColor)return result;
    auto copy=session->copy(texture.Get());if(!copy)return result;texture=std::move(copy);result.snapshot=true;result.recording=session->recordingContext();
  }
  result.texture=std::move(texture);result.extent=extent;result.format=description.Format;return result;
}
inline bool explicitSrgb(DXGI_FORMAT format){return format==DXGI_FORMAT_R8G8B8A8_UNORM_SRGB||format==DXGI_FORMAT_B8G8R8A8_UNORM_SRGB;}
inline bool sameViewport(const TaggedImage&a,const TaggedImage&b){return a.extent==b.extent;}
inline RSImageColorDescription srgbColor(uint32_t alpha){return{sizeof(RSImageColorDescription),1,RS_COLOR_BT709,RS_COLOR_SRGB,RS_COLOR_FULL,alpha,203,203,0,1.2f,0,0};}
inline MLStreamlineResourcesV2 resources(const TaggedFrame &frame){
  // Match the existing camera adapter's one-based native frame identity.
  MLStreamlineResourcesV2 result;result.frameId=uint64_t(frame.frame)+1;result.viewId=frame.view;result.epoch=frame.epoch;result.imageRevision=frame.revision;
  for(unsigned i=0;i<ML_SL_COUNT;++i){const auto &source=frame.images[i];if(!source.texture)continue;const auto &r=source.extent;
    result.images[i]={source.texture.Get(),r.left,r.top,r.width,r.height,uint32_t(source.format),source.snapshot?ML_SL_IMAGE_SNAPSHOT:0};result.snapshotContexts[i]=source.recording.Get();}
  const auto &world=frame.images[ML_SL_HUDLESS],&ui=frame.images[ML_SL_UI];
  // The SDK specifies premultiplied UI and a full-viewport pair. The tag name
  // alone does not declare encoding; only explicit sRGB formats are admitted.
  const auto &base=frame.images[ML_SL_COLOR],&composed=frame.images[ML_SL_COMPOSED];
  // Each tag's ROI describes this same viewport's full UV domain. Independent
  // allocations/resolutions are valid; equal pixel sizes are not provenance.
  if(world.texture&&ui.texture&&base.texture&&composed.texture==base.texture&&sameViewport(base,composed)&&explicitSrgb(base.format)&&world.format==base.format&&explicitSrgb(ui.format)){
    result.hudlessColor=srgbColor(RS_COLOR_OPAQUE);result.uiColor=srgbColor(RS_COLOR_PREMULTIPLIED);
  }else{result.images[ML_SL_HUDLESS]={};result.images[ML_SL_UI]={};}
  return result;
}
class ResourceTags {
  struct Marker{uint64_t age=0;uint32_t frame=0,view=0;};
  std::mutex mutex;ComPtr<ID3D11Device> device;std::array<TaggedFrame,16> entries{};std::array<Marker,16> markers{};uint64_t age=0,epoch=0;
public:
  void setDevice(void *native){
    ComPtr<ID3D11Device> next;if(native)static_cast<IUnknown*>(native)->QueryInterface(IID_PPV_ARGS(&next));
    std::lock_guard lock(mutex);device=std::move(next);entries={};markers={};++epoch;
  }
  void clear(){setDevice(nullptr);}
  void beginFrame(uint32_t frame,uint32_t view,bool accepted){
    std::lock_guard lock(mutex);Marker *target=&markers[0];
    for(auto &marker:markers){if(marker.age&&marker.view==view){target=&marker;break;}if(marker.age<target->age)target=&marker;}
    for(auto &entry:entries)if(entry.age&&!entry.framed&&entry.view==view&&(!accepted||entry.frame!=frame))entry={};
    *target=accepted?Marker{++age,frame,view}:Marker{};
  }
  void invalidateEvaluation(){std::lock_guard lock(mutex);entries={};}
  TaggedBatch capture(const sl::ResourceTag *tags,uint32_t count,void*commands=nullptr){
    TaggedBatch batch;batch.reset=!tags;ComPtr<ID3D11Device>owner;{std::lock_guard lock(mutex);batch.epoch=epoch;owner=device;}
    if(!owner)return batch;if(count>256||count&&!tags){batch.valid=false;return batch;}
    try{SnapshotSession session(owner.Get(),commands);for(uint32_t i=0;i<count;++i){const int slot=resourceSlot(tags[i].type);if(slot>=0)batch.images[slot]=taggedImage(tags[i],owner.Get(),&session);}}
    catch(...){batch.valid=false;batch.images={};}return batch;
  }
  void rememberCaptured(bool framed,uint32_t frame,uint32_t view,TaggedBatch batch,bool accepted){
    std::lock_guard lock(mutex);if(!device)return;
    if(batch.epoch!=epoch)return;
    if(!framed){bool known=false;for(const auto &marker:markers)if(marker.age&&marker.view==view){frame=marker.frame;known=true;break;}if(!known)return;}
    TaggedFrame *target=&entries[0];for(auto &entry:entries){if(entry.age&&entry.framed==framed&&entry.view==view&&(!framed||entry.frame==frame)){target=&entry;break;}if(entry.age<target->age)target=&entry;}
    if(!target->age||target->framed!=framed||target->view!=view||framed&&target->frame!=frame)*target={};
    target->age=++age;target->epoch=epoch;target->revision=age;target->frame=frame;target->view=view;target->framed=framed;
    if(!accepted||!batch.valid||batch.reset){target->images={};return;}
    for(unsigned i=0;i<ML_SL_COUNT;++i)if(batch.images[i].supplied)target->images[i]=std::move(batch.images[i]);
  }
  void remember(bool framed,uint32_t frame,uint32_t view,const sl::ResourceTag*tags,uint32_t count,bool accepted,void*commands=nullptr){rememberCaptured(framed,frame,view,capture(tags,count,commands),accepted);}
  TaggedFrame take(uint32_t frame,uint32_t view,const sl::BaseStructure **inputs,uint32_t count,void*commands=nullptr){
    std::vector<sl::ResourceTag>local;bool valid=count<=256&&(!count||inputs);
    try{if(valid)for(uint32_t i=0;i<count&&valid;++i){auto item=inputs[i];unsigned links=0;while(item&&links++<32){if(item->structType==sl::ResourceTag::s_structType){if(local.size()>=256){valid=false;break;}local.push_back(*static_cast<const sl::ResourceTag*>(item));}item=item->next;}if(item)valid=false;}}catch(...){valid=false;}
    auto batch=valid?capture(local.data(),uint32_t(local.size()),commands):TaggedBatch{};batch.valid&=valid;
    std::lock_guard lock(mutex);TaggedFrame result;result.frame=frame;result.view=view;result.epoch=epoch;result.revision=++age;if(!device)return result;
    // Legacy tags need successful same-frame constants before tagging. They
    // are consumed once and never guessed into a later frame token.
    for(bool framed:{false,true})for(auto &entry:entries)if(entry.age&&entry.epoch==epoch&&entry.framed==framed&&entry.view==view&&entry.frame==frame){
      for(unsigned i=0;i<ML_SL_COUNT;++i)if(entry.images[i].supplied)result.images[i]=std::move(entry.images[i]);entry={};break;
    }
    if(!batch.valid||batch.epoch!=epoch){result.images={};return result;}
    for(unsigned i=0;i<ML_SL_COUNT;++i)if(batch.images[i].supplied)result.images[i]=std::move(batch.images[i]);
    return result;
  }
};
}
