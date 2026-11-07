// Copyright (c) MacLauncher contributors. MIT license.
// Uses DXMT's original NGX parameter ABI and its actual D3D12 producer.
#include "temporal-d3d12.h"
#include <mutex>
namespace {
struct ML12Provider {
 HMODULE module=nullptr;MLTemporalD3D12Record record=nullptr;MLTemporalD3D12Release release=nullptr;MLTemporalD3D12Supported supports=nullptr;
 explicit ML12Provider(IUnknown*object){
  if(!object)return;
  auto address=(*reinterpret_cast<void***>(object))[0];
  if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,reinterpret_cast<LPCWSTR>(address),&module))return;
  record=reinterpret_cast<MLTemporalD3D12Record>(GetProcAddress(module,"MacLauncherDXMTTemporalUpscale12"));
  release=reinterpret_cast<MLTemporalD3D12Release>(GetProcAddress(module,"MacLauncherDXMTReleaseTemporal12"));
  supports=reinterpret_cast<MLTemporalD3D12Supported>(GetProcAddress(module,"MacLauncherDXMTTemporal12Supported"));
  if(!record||!release||!supports){FreeLibrary(module);module=nullptr;}
 }
 ~ML12Provider(){if(module)FreeLibrary(module);}
};
std::mutex ml12InitMutex;Com<ID3D12Device>ml12Initialized;
struct ML12Feature:DLSSFeature {
 std::unique_ptr<ML12Provider>provider;Com<ID3D12Device>device;void*history=nullptr;uint64_t frames=0;std::mutex mutex;
 ~ML12Feature(){if(history)provider->release(history);}
};
template<class T>T ml12Get(NVNGXParameter*p,const char*name,T fallback){T value{};return p->Get(name,&value)==NVNGX_RESULT_OK?value:fallback;}
NVNGX_RESULT ml12Init(ID3D12Device*device){ML12Provider producer(device);if(!producer.module||!producer.supports(device))return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;std::lock_guard guard(ml12InitMutex);ml12Initialized=device;return NVNGX_RESULT_OK;}
}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_Init(unsigned long long,const wchar_t*,ID3D12Device*device,const void*,unsigned int){return ml12Init(device);}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_Init_Ext(unsigned long long,const wchar_t*,ID3D12Device*device,unsigned int,const void*){return ml12Init(device);}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_Init_ProjectID(const char*,unsigned int,const char*,const wchar_t*,ID3D12Device*device,unsigned int,const void*){return ml12Init(device);}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_Init_with_ProjectID(const char*,unsigned int,const char*,const wchar_t*,ID3D12Device*device,const void*,unsigned int){return ml12Init(device);}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_Shutdown(){std::lock_guard guard(ml12InitMutex);ml12Initialized=nullptr;return NVNGX_RESULT_OK;}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_Shutdown1(ID3D12Device*){return NVSDK_NGX_D3D12_Shutdown();}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_AllocateParameters(NVNGXParameter**out){return out?NVSDK_NGX_D3D11_AllocateParameters(out):NVNGX_RESULT_INVALID_PARAMETER;}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_DestroyParameters(NVNGXParameter*p){return NVSDK_NGX_D3D11_DestroyParameters(p);}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_GetCapabilityParameters(NVNGXParameter**out){
 if(!out)return NVNGX_RESULT_INVALID_PARAMETER;auto result=NVSDK_NGX_D3D11_GetCapabilityParameters(out);if(result!=NVNGX_RESULT_OK)return result;
 std::lock_guard guard(ml12InitMutex);const unsigned available=ml12Initialized.ptr()!=nullptr;
 (*out)->Set("SuperSampling.Available",available);(*out)->Set(NVSDK_NGX_EParameter_SuperSampling_Available,available);return result;
}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_GetParameters(NVNGXParameter**out){return NVSDK_NGX_D3D12_GetCapabilityParameters(out);}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_GetScratchBufferSize(unsigned int feature,const NVNGXParameter*p,size_t*out){return out?NVSDK_NGX_D3D11_GetScratchBufferSize(feature,p,out):NVNGX_RESULT_INVALID_PARAMETER;}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_CreateFeature(ID3D12GraphicsCommandList*commands,unsigned int feature,NVNGXParameter*p,unsigned int**out){
 if(!commands||!p||!out)return NVNGX_RESULT_INVALID_PARAMETER;*out=nullptr;
 if(feature!=NVNGX_FEATURE_SUPERSAMPLING)return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;
 auto next=std::make_unique<ML12Feature>();next->provider=std::make_unique<ML12Provider>(commands);
 if(!next->provider->module)return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;
 if(FAILED(commands->GetDevice(IID_PPV_ARGS(&next->device))))return NVNGX_RESULT_FAIL;
 if(!next->provider->supports(next->device.ptr()))return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;
 next->feature=NVNGX_FEATURE_SUPERSAMPLING;
 if(p->Get(NVNGX_Parameter_Width,&next->width)!=NVNGX_RESULT_OK||p->Get(NVNGX_Parameter_Height,&next->height)!=NVNGX_RESULT_OK||p->Get(NVNGX_Parameter_OutWidth,&next->target_width)!=NVNGX_RESULT_OK||p->Get(NVNGX_Parameter_OutHeight,&next->target_height)!=NVNGX_RESULT_OK||!next->width||!next->height||!next->target_width||!next->target_height)return NVNGX_RESULT_INVALID_PARAMETER;
 next->flag=ml12Get(p,NVNGX_Parameter_DLSS_Feature_Create_Flags,0);next->quality=ml12Get(p,NVNGX_Parameter_PerfQualityValue,0);next->enable_output_subrects=ml12Get(p,"DLSS.Enable.Output.Subrects",0);
 *out=&next.release()->handle;return NVNGX_RESULT_OK;
}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_EvaluateFeature(ID3D12GraphicsCommandList*commands,const unsigned int*handle,NVNGXParameter*p,void*){
 if(!commands||!handle||!p)return NVNGX_RESULT_INVALID_PARAMETER;auto feature=static_cast<ML12Feature*>((void*)handle);std::lock_guard guard(feature->mutex);
 if(feature->feature!=NVNGX_FEATURE_SUPERSAMPLING)return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;
 MLTemporalD3D12 input;input.maxWidth=feature->width;input.maxHeight=feature->height;
 if(p->Get(NVNGX_Parameter_Color,&input.color)!=NVNGX_RESULT_OK||p->Get(NVNGX_Parameter_Depth,&input.depth)!=NVNGX_RESULT_OK||p->Get(NVNGX_Parameter_MotionVectors,&input.motion)!=NVNGX_RESULT_OK||p->Get(NVNGX_Parameter_Output,&input.output)!=NVNGX_RESULT_OK)return NVNGX_RESULT_INVALID_PARAMETER;
 if(!input.color||!input.depth||!input.motion||!input.output)return NVNGX_RESULT_INVALID_PARAMETER;
 p->Get(NVNGX_Parameter_ExposureTexture,&input.exposure);
 input.width=ml12Get(p,NVNGX_Parameter_DLSS_Render_Subrect_Dimensions_Width,feature->width);input.height=ml12Get(p,NVNGX_Parameter_DLSS_Render_Subrect_Dimensions_Height,feature->height);
 // This complete-image producer has no atlas rebasing operation.
 for(const char*name:{"DLSS.Input.Color.Subrect.Base.X","DLSS.Input.Color.Subrect.Base.Y","DLSS.Input.Depth.Subrect.Base.X","DLSS.Input.Depth.Subrect.Base.Y","DLSS.Input.MV.Subrect.Base.X","DLSS.Input.MV.Subrect.Base.Y","DLSS.Output.Subrect.Base.X","DLSS.Output.Subrect.Base.Y"})if(ml12Get(p,name,0u))return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;
 auto output=input.output->GetDesc();if(output.Width!=feature->target_width||output.Height!=feature->target_height)return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;
 input.jitterX=ml12Get(p,NVNGX_Parameter_Jitter_Offset_X,0.f);input.jitterY=ml12Get(p,NVNGX_Parameter_Jitter_Offset_Y,0.f);input.motionScaleX=ml12Get(p,NVNGX_Parameter_MV_Scale_X,1.f);input.motionScaleY=ml12Get(p,NVNGX_Parameter_MV_Scale_Y,1.f);input.preExposure=ml12Get(p,NVNGX_Parameter_DLSS_Pre_Exposure,1.f);if(input.preExposure==0)input.preExposure=1;
 input.reset=ml12Get(p,NVNGX_Parameter_Reset,0)!=0;input.autoExposure=feature->flag&NVNGX_DLSS_FLAG_AUTO_EXPOSURE;input.displayMotion=!(feature->flag&NVNGX_DLSS_FLAG_MV_LOWRES);
 input.flags=(input.reset?RS_TEMPORAL_RESET:0)|(input.autoExposure?RS_TEMPORAL_AUTO_EXPOSURE:0)|(input.displayMotion?RS_TEMPORAL_OUTPUT_MOTION:0)|((feature->flag&1)?RS_TEMPORAL_HDR:0)|((feature->flag&NVNGX_DLSS_FLAG_DEPTH_INVERTED)?RS_TEMPORAL_DEPTH_REVERSED:0)|((feature->flag&NVNGX_DLSS_FLAG_MV_JITTERED)?RS_TEMPORAL_JITTERED_MOTION:0);
 input.camera=mlCamera;input.frameId=++feature->frames;input.frameTimeMs=ml12Get(p,"FrameTimeDeltaInMsec",0.f);input.sharpness=ml12Get(p,NVNGX_Parameter_Sharpness,0.f);
 if(input.camera.size){input.frameId=input.camera.frameId;if(!(input.frameTimeMs>0))input.frameTimeMs=input.camera.frameTimeMs;}
 if(!std::isfinite(input.jitterX)||!std::isfinite(input.jitterY)||!std::isfinite(input.motionScaleX)||!std::isfinite(input.motionScaleY)||!std::isfinite(input.preExposure)||input.preExposure<=0||!std::isfinite(input.frameTimeMs)||input.frameTimeMs<0)return NVNGX_RESULT_INVALID_PARAMETER;
 const auto result=feature->provider->record(commands,&input,&feature->history);return SUCCEEDED(result)?NVNGX_RESULT_OK:result==DXGI_ERROR_UNSUPPORTED?NVNGX_RESULT_FEATURE_NOT_SUPPORTED:result==E_INVALIDARG?NVNGX_RESULT_INVALID_PARAMETER:NVNGX_RESULT_FAIL;
}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_ReleaseFeature(unsigned int*handle){if(!handle)return NVNGX_RESULT_INVALID_PARAMETER;delete static_cast<ML12Feature*>((void*)handle);return NVNGX_RESULT_OK;}
NVNGX_API NVNGX_RESULT NVSDK_NGX_D3D12_GetFeatureRequirements(IDXGIAdapter*a,const NVNGX_FeatureDiscoveryInfo*d,NVNGX_FeatureRequirement*r){if(!a||!d||!r)return NVNGX_RESULT_INVALID_PARAMETER;
 Com<IMTLDXGIAdapter>nativeAdapter;
 const bool supported=SUCCEEDED(a->QueryInterface(IID_PPV_ARGS(&nativeAdapter)))&&nativeAdapter->GetMTLDevice().supportsFXTemporalScaler();
 auto result=NVSDK_NGX_D3D11_GetFeatureRequirements(a,d,r);
 if(!supported){r->FeatureSupported=NVNGX_FEATURE_SUPPORT_RESULT_UNSUPPORTED;return NVNGX_RESULT_FEATURE_NOT_SUPPORTED;}return result;}
