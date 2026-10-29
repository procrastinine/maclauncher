#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <atomic>
#include <memory>
#include <mutex>
#include <vector>
#include <dxgi1_4.h>
#include <wrl/client.h>
#include "../dxmt/streamline-snapshot.hpp"
#include "snapshot-budget.hpp"
namespace maclauncher_streamline {
using Microsoft::WRL::ComPtr;
inline unsigned snapshotPixelBytes(DXGI_FORMAT f){switch(f){
 case DXGI_FORMAT_R32G32B32A32_FLOAT:return 16;
 case DXGI_FORMAT_R16G16B16A16_FLOAT:case DXGI_FORMAT_R16G16B16A16_UNORM:case DXGI_FORMAT_R32G32_FLOAT:
 case DXGI_FORMAT_R32G8X24_TYPELESS:case DXGI_FORMAT_D32_FLOAT_S8X24_UINT:case DXGI_FORMAT_R32_FLOAT_X8X24_TYPELESS:
 case DXGI_FORMAT_R24G8_TYPELESS:case DXGI_FORMAT_D24_UNORM_S8_UINT:case DXGI_FORMAT_R24_UNORM_X8_TYPELESS:return 8;
 case DXGI_FORMAT_R8G8B8A8_UNORM:case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:case DXGI_FORMAT_R8G8B8A8_TYPELESS:
 case DXGI_FORMAT_B8G8R8A8_UNORM:case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:case DXGI_FORMAT_B8G8R8A8_TYPELESS:
 case DXGI_FORMAT_R10G10B10A2_UNORM:case DXGI_FORMAT_R11G11B10_FLOAT:case DXGI_FORMAT_R32_FLOAT:case DXGI_FORMAT_R32_TYPELESS:
 case DXGI_FORMAT_D32_FLOAT:
 case DXGI_FORMAT_R16G16_FLOAT:case DXGI_FORMAT_R16G16_UNORM:case DXGI_FORMAT_R16G16_SNORM:return 4;
 case DXGI_FORMAT_R16_FLOAT:case DXGI_FORMAT_R16_UNORM:case DXGI_FORMAT_R16_TYPELESS:case DXGI_FORMAT_D16_UNORM:case DXGI_FORMAT_R8G8_UNORM:return 2;
 case DXGI_FORMAT_R8_UNORM:return 1;default:return 0;
}}
inline bool memoryBudget(ID3D11Device*device,DXGI_QUERY_VIDEO_MEMORY_INFO&info,uint64_t&identity){
 ComPtr<IDXGIDevice>dxgi;ComPtr<IDXGIAdapter>adapter;ComPtr<IDXGIAdapter3>modern;
 DXGI_ADAPTER_DESC desc{};if(FAILED(device->QueryInterface(IID_PPV_ARGS(&dxgi)))||FAILED(dxgi->GetAdapter(&adapter))||FAILED(adapter->GetDesc(&desc))||FAILED(adapter.As(&modern))||FAILED(modern->QueryVideoMemoryInfo(0,DXGI_MEMORY_SEGMENT_GROUP_LOCAL,&info)))return false;
 identity=(uint64_t(uint32_t(desc.AdapterLuid.HighPart))<<32)|desc.AdapterLuid.LowPart;return true;
}
inline void snapshotCodeAnchor(){}
class SnapshotLease final:public IUnknown {
 std::atomic<ULONG>refs{1};std::shared_ptr<SnapshotReservation>reservation;
 explicit SnapshotLease(std::shared_ptr<SnapshotReservation>value):reservation(std::move(value)){}
public:
 static ComPtr<SnapshotLease>reserve(ID3D11Device*device,const D3D11_TEXTURE2D_DESC&desc){
  const auto bytes=macfx::alignedImageBytes(desc.Width,desc.Height,snapshotPixelBytes(desc.Format));DXGI_QUERY_VIDEO_MEMORY_INFO info{};uint64_t adapter=0;if(!bytes||!memoryBudget(device,info,adapter))return{};
  auto reservation=SnapshotReservation::reserve(snapshotBudget(adapter),info.Budget,info.CurrentUsage,bytes);if(!reservation)return{};
  // Allocation leases can outlive slShutdown while DXMT retires recorded GPU
  // work. Keep this small proxy's COM implementation mapped for that lifetime.
  HMODULE module=nullptr;if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,reinterpret_cast<LPCWSTR>(&snapshotCodeAnchor),&module))return{};
  ComPtr<SnapshotLease>result;try{result.Attach(new SnapshotLease(std::move(reservation)));}catch(...){return{};}return result;
 }
 void commit(){reservation->commit();}
 static bool admittedAfterCreate(ID3D11Device*device){DXGI_QUERY_VIDEO_MEMORY_INFO info{};uint64_t adapter=0;if(!memoryBudget(device,info,adapter))return false;auto budget=snapshotBudget(adapter);std::lock_guard lock(budget->mutex);return macfx::admitImageBytes({info.Budget,info.CurrentUsage,budget->committed,budget->pending},1).admitted;}
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void**out)override{if(!out)return E_POINTER;*out=nullptr;if(id!=__uuidof(IUnknown))return E_NOINTERFACE;*out=this;AddRef();return S_OK;}
 ULONG STDMETHODCALLTYPE AddRef()override{return refs.fetch_add(1)+1;}
 ULONG STDMETHODCALLTYPE Release()override{const auto value=refs.fetch_sub(1)-1;if(!value)delete this;return value;}
};
class SnapshotSession {
 struct Copy{ComPtr<ID3D11Texture2D>source,snapshot;};
 ComPtr<ID3D11Device>device;ComPtr<ID3D11DeviceContext>context;std::vector<Copy>copies;
public:
 SnapshotSession(ID3D11Device*owner,void*commands):device(owner){
  ComPtr<IUnknown>marker;ComPtr<ID3D11Device>actual;
  if(!owner||!commands||FAILED(static_cast<IUnknown*>(commands)->QueryInterface(IID_PPV_ARGS(&context))))return;
  context->GetDevice(&actual);if(actual.Get()!=owner||FAILED(context->QueryInterface(MLStreamlineSnapshotContextGuid,&marker))){context.Reset();return;}
  const auto type=context->GetType();if(type!=D3D11_DEVICE_CONTEXT_IMMEDIATE&&type!=D3D11_DEVICE_CONTEXT_DEFERRED)context.Reset();
 }
 ID3D11DeviceContext*recordingContext()const{return context.Get();}
 ComPtr<ID3D11Texture2D>copy(ID3D11Texture2D*source){
  if(!context||!source)return{};for(const auto&copy:copies)if(copy.source.Get()==source)return copy.snapshot;
  ComPtr<IUnknown>marker;if(FAILED(source->QueryInterface(MLStreamlineSnapshotResourceGuid,&marker)))return{};
  D3D11_TEXTURE2D_DESC desc{};source->GetDesc(&desc);desc.MipLevels=1;desc.Usage=D3D11_USAGE_DEFAULT;desc.CPUAccessFlags=0;desc.MiscFlags=0;
  auto lease=SnapshotLease::reserve(device.Get(),desc);if(!lease)return{};ComPtr<ID3D11Texture2D>snapshot;
  if(FAILED(device->CreateTexture2D(&desc,nullptr,&snapshot))||!snapshot)return{};lease->commit();
  if(!SnapshotLease::admittedAfterCreate(device.Get())||FAILED(snapshot->QueryInterface(MLStreamlineSnapshotResourceGuid,&marker))||FAILED(snapshot->SetPrivateDataInterface(MLStreamlineSnapshotLeaseGuid,lease.Get())))return{};
  context->CopySubresourceRegion(snapshot.Get(),0,0,0,0,source,0,nullptr);
  UINT bytes=sizeof(uint32_t);uint32_t recorded=0;if(FAILED(snapshot->GetPrivateData(MLStreamlineSnapshotRecordedGuid,&bytes,&recorded))||bytes!=sizeof(recorded)||recorded!=1)return{};
  copies.push_back({source,snapshot});return snapshot;
 }
};
}
