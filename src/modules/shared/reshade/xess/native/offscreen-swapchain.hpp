#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include <dxgi1_6.h>
#include <d3d12.h>
#include <wrl/client.h>
#include <atomic>
#include <functional>
#include <mutex>
#include <stdexcept>
namespace macfx::xess {
using Microsoft::WRL::ComPtr;
using OutputCapture=std::function<HRESULT(ID3D12CommandQueue*,ID3D12Resource*,std::function<void()>)>;
// The SDK receives an ordinary DXGI swapchain contract. Present transfers a
// backbuffer into the caller's bounded GPU sink; it never presents a window.
class OffscreenSwapChain final:public IDXGISwapChain4 {
 std::atomic<ULONG>refs{1};ComPtr<IDXGISwapChain4>real;ComPtr<IDXGIFactory2>parent;ComPtr<ID3D12CommandQueue>queue;std::atomic<unsigned>index{0},presents{0};std::mutex presentLock;OutputCapture capture;HANDLE latency=CreateEventW(nullptr,FALSE,TRUE,nullptr);
public:
 OffscreenSwapChain(IDXGISwapChain4*s,IDXGIFactory2*p,ID3D12CommandQueue*q,OutputCapture sink):real(s),parent(p),queue(q),capture(std::move(sink)){if(!latency)throw std::runtime_error("Cannot allocate the XeSS generation readiness event");}
 void completedGPU(){if(!SetEvent(latency))ExitProcess(5);}
 ~OffscreenSwapChain(){CloseHandle(latency);}
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void**out)override{if(!out)return E_POINTER;*out=nullptr;if(id==__uuidof(IUnknown)||id==__uuidof(IDXGIObject)||id==__uuidof(IDXGIDeviceSubObject)||id==__uuidof(IDXGISwapChain)||id==__uuidof(IDXGISwapChain1)||id==__uuidof(IDXGISwapChain2)||id==__uuidof(IDXGISwapChain3)||id==__uuidof(IDXGISwapChain4)){*out=static_cast<IDXGISwapChain4*>(this);AddRef();return S_OK;}return E_NOINTERFACE;}
 ULONG STDMETHODCALLTYPE AddRef()override{return++refs;}ULONG STDMETHODCALLTYPE Release()override{auto n=--refs;if(!n)delete this;return n;}
#define FORWARD(name,args,call) HRESULT STDMETHODCALLTYPE name args override{return real->name call;}
 FORWARD(SetPrivateData,(REFGUID n,UINT s,const void*d),(n,s,d)) FORWARD(SetPrivateDataInterface,(REFGUID n,const IUnknown*p),(n,p)) FORWARD(GetPrivateData,(REFGUID n,UINT*s,void*d),(n,s,d))
 HRESULT STDMETHODCALLTYPE GetParent(REFIID id,void**p)override{return parent->QueryInterface(id,p);}
 FORWARD(GetDevice,(REFIID id,void**p),(id,p)) FORWARD(GetBuffer,(UINT i,REFIID id,void**p),(i,id,p)) HRESULT STDMETHODCALLTYPE SetFullscreenState(BOOL b,IDXGIOutput*)override{return b?DXGI_ERROR_NOT_CURRENTLY_AVAILABLE:S_OK;} HRESULT STDMETHODCALLTYPE GetFullscreenState(BOOL*b,IDXGIOutput**o)override{if(!b)return E_POINTER;*b=FALSE;if(o)*o=nullptr;return S_OK;} FORWARD(GetDesc,(DXGI_SWAP_CHAIN_DESC*d),(d))
 HRESULT STDMETHODCALLTYPE ResizeBuffers(UINT n,UINT w,UINT h,DXGI_FORMAT f,UINT flags)override{auto r=real->ResizeBuffers(n,w,h,f,flags);if(SUCCEEDED(r))index=0;return r;}
 FORWARD(ResizeTarget,(const DXGI_MODE_DESC*d),(d)) FORWARD(GetContainingOutput,(IDXGIOutput**p),(p))
 HRESULT STDMETHODCALLTYPE GetFrameStatistics(DXGI_FRAME_STATISTICS*)override{return DXGI_ERROR_FRAME_STATISTICS_DISJOINT;}
 HRESULT STDMETHODCALLTYPE GetLastPresentCount(UINT*p)override{if(!p)return E_POINTER;*p=presents;return S_OK;}
 FORWARD(GetDesc1,(DXGI_SWAP_CHAIN_DESC1*d),(d)) FORWARD(GetFullscreenDesc,(DXGI_SWAP_CHAIN_FULLSCREEN_DESC*d),(d)) FORWARD(GetHwnd,(HWND*p),(p)) FORWARD(GetCoreWindow,(REFIID id,void**p),(id,p))
 BOOL STDMETHODCALLTYPE IsTemporaryMonoSupported()override{return real->IsTemporaryMonoSupported();}
 FORWARD(GetRestrictToOutput,(IDXGIOutput**p),(p)) FORWARD(SetBackgroundColor,(const DXGI_RGBA*c),(c)) FORWARD(GetBackgroundColor,(DXGI_RGBA*c),(c)) FORWARD(SetRotation,(DXGI_MODE_ROTATION r),(r)) FORWARD(GetRotation,(DXGI_MODE_ROTATION*r),(r)) FORWARD(SetSourceSize,(UINT w,UINT h),(w,h)) FORWARD(GetSourceSize,(UINT*w,UINT*h),(w,h)) FORWARD(SetMaximumFrameLatency,(UINT n),(n)) FORWARD(GetMaximumFrameLatency,(UINT*n),(n))
 HANDLE STDMETHODCALLTYPE GetFrameLatencyWaitableObject()override{return latency;}
 FORWARD(SetMatrixTransform,(const DXGI_MATRIX_3X2_F*m),(m)) FORWARD(GetMatrixTransform,(DXGI_MATRIX_3X2_F*m),(m))
 UINT STDMETHODCALLTYPE GetCurrentBackBufferIndex()override{return index;}
 FORWARD(CheckColorSpaceSupport,(DXGI_COLOR_SPACE_TYPE s,UINT*p),(s,p)) FORWARD(SetColorSpace1,(DXGI_COLOR_SPACE_TYPE s),(s))
 HRESULT STDMETHODCALLTYPE ResizeBuffers1(UINT n,UINT w,UINT h,DXGI_FORMAT f,UINT flags,const UINT*m,IUnknown*const*q)override{auto r=real->ResizeBuffers1(n,w,h,f,flags,m,q);if(SUCCEEDED(r))index=0;return r;}
 FORWARD(SetHDRMetaData,(DXGI_HDR_METADATA_TYPE t,UINT s,void*p),(t,s,p))
#undef FORWARD
 HRESULT STDMETHODCALLTYPE Present1(UINT sync,UINT flags,const DXGI_PRESENT_PARAMETERS*p)override{if(p&&(p->DirtyRectsCount||p->pScrollRect||p->pScrollOffset))return DXGI_ERROR_INVALID_CALL;return Present(sync,flags);}
 HRESULT STDMETHODCALLTYPE Present(UINT,UINT flags)override{
  if(flags&DXGI_PRESENT_TEST)return S_OK;
  std::lock_guard guard(presentLock);ComPtr<ID3D12Resource>source;auto result=real->GetBuffer(index,IID_PPV_ARGS(&source));if(FAILED(result))return result;
  ComPtr<OffscreenSwapChain> retained(this);result=capture(queue.Get(),source.Get(),[retained]{retained->completedGPU();});if(FAILED(result))return result;
  DXGI_SWAP_CHAIN_DESC1 desc{};result=real->GetDesc1(&desc);if(FAILED(result)||!desc.BufferCount)return DXGI_ERROR_INVALID_CALL;
  index=(index+1)%desc.BufferCount;++presents;return S_OK;
 }
};
class OffscreenFactory final:public IDXGIFactory2 {
 std::atomic<ULONG>refs{1};ComPtr<IDXGIFactory2>real;OutputCapture capture;
public:OffscreenFactory(IDXGIFactory2*r,OutputCapture sink):real(r),capture(std::move(sink)){}
 HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void**out)override{if(!out)return E_POINTER;*out=nullptr;if(id==__uuidof(IUnknown)||id==__uuidof(IDXGIObject)||id==__uuidof(IDXGIFactory)||id==__uuidof(IDXGIFactory1)||id==__uuidof(IDXGIFactory2)){*out=this;AddRef();return S_OK;}return E_NOINTERFACE;}
 ULONG STDMETHODCALLTYPE AddRef()override{return++refs;}ULONG STDMETHODCALLTYPE Release()override{auto n=--refs;if(!n)delete this;return n;}
#define FORWARD(name,args,call) HRESULT STDMETHODCALLTYPE name args override{return real->name call;}
 FORWARD(SetPrivateData,(REFGUID n,UINT s,const void*d),(n,s,d)) FORWARD(SetPrivateDataInterface,(REFGUID n,const IUnknown*p),(n,p)) FORWARD(GetPrivateData,(REFGUID n,UINT*s,void*d),(n,s,d)) FORWARD(GetParent,(REFIID id,void**p),(id,p)) FORWARD(EnumAdapters,(UINT i,IDXGIAdapter**p),(i,p)) FORWARD(MakeWindowAssociation,(HWND h,UINT f),(h,f)) FORWARD(GetWindowAssociation,(HWND*h),(h)) FORWARD(CreateSwapChain,(IUnknown*d,DXGI_SWAP_CHAIN_DESC*s,IDXGISwapChain**p),(d,s,p)) FORWARD(CreateSoftwareAdapter,(HMODULE m,IDXGIAdapter**p),(m,p)) FORWARD(EnumAdapters1,(UINT i,IDXGIAdapter1**p),(i,p))
 BOOL STDMETHODCALLTYPE IsCurrent()override{return real->IsCurrent();}BOOL STDMETHODCALLTYPE IsWindowedStereoEnabled()override{return real->IsWindowedStereoEnabled();}
 HRESULT STDMETHODCALLTYPE CreateSwapChainForHwnd(IUnknown*d,HWND h,const DXGI_SWAP_CHAIN_DESC1*s,const DXGI_SWAP_CHAIN_FULLSCREEN_DESC*f,IDXGIOutput*o,IDXGISwapChain1**p)override{ComPtr<IDXGISwapChain1>actual;auto r=real->CreateSwapChainForHwnd(d,h,s,f,o,&actual);if(FAILED(r))return r;ComPtr<IDXGISwapChain4>four;r=actual.As(&four);if(FAILED(r))return r;ComPtr<ID3D12CommandQueue>q;r=d->QueryInterface(IID_PPV_ARGS(&q));if(FAILED(r))return r;auto sink=new OffscreenSwapChain(four.Get(),this,q.Get(),capture);*p=sink;return S_OK;}
 FORWARD(CreateSwapChainForCoreWindow,(IUnknown*d,IUnknown*w,const DXGI_SWAP_CHAIN_DESC1*s,IDXGIOutput*o,IDXGISwapChain1**p),(d,w,s,o,p)) FORWARD(GetSharedResourceAdapterLuid,(HANDLE h,LUID*l),(h,l)) FORWARD(RegisterStereoStatusWindow,(HWND h,UINT m,DWORD*c),(h,m,c)) FORWARD(RegisterStereoStatusEvent,(HANDLE h,DWORD*c),(h,c))
 void STDMETHODCALLTYPE UnregisterStereoStatus(DWORD c)override{real->UnregisterStereoStatus(c);}
 FORWARD(RegisterOcclusionStatusWindow,(HWND h,UINT m,DWORD*c),(h,m,c)) FORWARD(RegisterOcclusionStatusEvent,(HANDLE h,DWORD*c),(h,c))
 void STDMETHODCALLTYPE UnregisterOcclusionStatus(DWORD c)override{real->UnregisterOcclusionStatus(c);}
 FORWARD(CreateSwapChainForComposition,(IUnknown*d,const DXGI_SWAP_CHAIN_DESC1*s,IDXGIOutput*o,IDXGISwapChain1**p),(d,s,o,p))
#undef FORWARD
};

}
