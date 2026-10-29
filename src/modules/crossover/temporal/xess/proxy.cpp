// Copyright (c) MacLauncher contributors. MIT license.
// Public XeSS API compatibility. Reconstruction executes the actual selected
// Mac provider through DXMT; this library does not contain Intel inference.
#define NOMINMAX
#define XESS_SHARED_LIB
#define XESS_EXPORT_API
#include <windows.h>
#include <d3d11.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include <xess/xess_d3d11.h>
#include <d3d11_interfaces.hpp>
#include "camera-transport.hpp"
#include <algorithm>
#include <cmath>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>
#include <cstring>
#include <cstdio>
#include "exports.hpp"
using Microsoft::WRL::ComPtr;
namespace {
HMODULE module=nullptr;
struct Context {
    std::mutex mutex;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> immediate,commands;
    ComPtr<IMTLD3D11ContextExt1> extension;
    xess_d3d11_init_params_t init{};
    bool initialized=false,legacy=false;
    float jitterX=1,jitterY=1,velocityX=1,velocityY=1,exposure=1,maxResponsive=.8f;
    float previousJitterX=0,previousJitterY=0;bool motionHistory=false;
    xess_app_log_callback_t logger=nullptr;xess_logging_level_t logging=XESS_LOGGING_LEVEL_INFO;
    struct CachedImage {D3D11_TEXTURE2D_DESC description{};ComPtr<ID3D11Texture2D> value;};
    CachedImage color,depth,motion,output,exposureImage,normalizedMotion,responsiveImage,responsiveCrop;
    ComPtr<ID3D11ComputeShader> motionShader,exposureShader,responsiveShader;ComPtr<ID3D11Buffer> constants;
    struct SourceView {ComPtr<ID3D11Resource> resource;ComPtr<ID3D11ShaderResourceView> view;};std::vector<SourceView> views;
};
HRESULT failure(Context &state,const char *operation,HRESULT result){if(FAILED(result)&&state.logger&&state.logging<=XESS_LOGGING_LEVEL_ERROR){char message[256];std::snprintf(message,sizeof(message),"%s failed (0x%08lx)",operation,(unsigned long)result);state.logger(message,XESS_LOGGING_LEVEL_ERROR);}return result;}
std::mutex contextsMutex;
std::unordered_map<xess_context_handle_t,std::shared_ptr<Context>> contexts;
std::shared_ptr<Context> context(xess_context_handle_t handle){std::lock_guard lock(contextsMutex);const auto found=contexts.find(handle);return found==contexts.end()?nullptr:found->second;}
template<typename F>xess_result_t use(xess_context_handle_t handle,F operation){
    const auto value=context(handle);if(!value)return XESS_RESULT_ERROR_INVALID_CONTEXT;
    try{std::lock_guard lock(value->mutex);return operation(*value);}
    catch(const std::bad_alloc&){return XESS_RESULT_ERROR_DEVICE_OUT_OF_MEMORY;}
    catch(...){return XESS_RESULT_ERROR_DEVICE;}
}
bool extent(const xess_2d_t &size){return size.x&&size.y&&size.x<=D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION&&size.y<=D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION;}
float ratio(xess_quality_settings_t quality,bool legacy){
    const float current[]={3,2.3f,2,1.7f,1.5f,1.3f,1};
    const float previous[]={3,2,1.7f,1.5f,1.3f,1.3f,1};
    const int index=int(quality)-int(XESS_QUALITY_SETTING_ULTRA_PERFORMANCE);
    return index>=0&&index<7?(legacy?previous[index]:current[index]):0;
}
xess_result_t inputResolution(Context &state,const xess_2d_t *output,xess_quality_settings_t quality,xess_2d_t *input){
    const auto scale=ratio(quality,state.legacy);if(!output||!input||!extent(*output)||!scale)return XESS_RESULT_ERROR_INVALID_ARGUMENT;
    input->x=std::max(1u,uint32_t(std::lround(output->x/scale)));input->y=std::max(1u,uint32_t(std::lround(output->y/scale)));return XESS_RESULT_SUCCESS;
}
bool texture(ID3D11Resource *resource,ComPtr<ID3D11Texture2D> &value,D3D11_TEXTURE2D_DESC &description){
    if(!resource||FAILED(resource->QueryInterface(IID_PPV_ARGS(&value))))return false;
    value->GetDesc(&description);return description.ArraySize==1&&description.SampleDesc.Count==1;
}
HRESULT scratch(Context &state,Context::CachedImage &slot,D3D11_TEXTURE2D_DESC description){
    description.MipLevels=1;description.ArraySize=1;description.Usage=D3D11_USAGE_DEFAULT;description.CPUAccessFlags=0;description.MiscFlags=0;
    if(slot.value&&slot.description.Width==description.Width&&slot.description.Height==description.Height&&slot.description.Format==description.Format&&slot.description.BindFlags==description.BindFlags)return S_OK;
    ComPtr<ID3D11Texture2D> next;const auto result=state.device->CreateTexture2D(&description,nullptr,&next);
    if(SUCCEEDED(result)){slot.value=next;slot.description=description;}return result;
}
xess_result_t crop(Context &state,ID3D11Resource *resource,xess_coord_t base,uint32_t width,uint32_t height,
    Context::CachedImage &slot,ComPtr<ID3D11Texture2D> &result,bool preserveAllocation=false){
    D3D11_TEXTURE2D_DESC description{};if(!texture(resource,result,description)||uint64_t(base.x)+width>description.Width||uint64_t(base.y)+height>description.Height)return XESS_RESULT_ERROR_INVALID_ARGUMENT;
    if(!base.x&&!base.y&&(preserveAllocation||description.Width==width&&description.Height==height))return XESS_RESULT_SUCCESS;
    description.Width=width;description.Height=height;if(FAILED(scratch(state,slot,description)))return XESS_RESULT_ERROR_DEVICE_OUT_OF_MEMORY;
    D3D11_BOX box{base.x,base.y,0,base.x+width,base.y+height,1};state.commands->CopySubresourceRegion(slot.value.Get(),0,0,0,0,resource,0,&box);result=slot.value;return XESS_RESULT_SUCCESS;
}
HRESULT shader(Context &state,ComPtr<ID3D11ComputeShader> &target,const char *source){
    if(target)return S_OK;ComPtr<ID3DBlob> code,error;auto result=D3DCompile(source,std::strlen(source),"XeSSGuideNormalization",nullptr,nullptr,"main","cs_5_0",D3DCOMPILE_OPTIMIZATION_LEVEL3,0,&code,&error);
    if(FAILED(result)){if(state.logger&&error)state.logger(static_cast<const char*>(error->GetBufferPointer()),XESS_LOGGING_LEVEL_ERROR);return failure(state,"GPU guide shader compilation",result);}
    return failure(state,"GPU guide shader creation",state.device->CreateComputeShader(code->GetBufferPointer(),code->GetBufferSize(),nullptr,&target));
}
HRESULT sourceView(Context &state,ID3D11Resource *resource,ComPtr<ID3D11ShaderResourceView> &view){
    for(auto &row:state.views)if(row.resource.Get()==resource){view=row.view;return S_OK;}
    ComPtr<ID3D11Texture2D> image;D3D11_TEXTURE2D_DESC description{};if(!texture(resource,image,description))return E_INVALIDARG;
    auto format=description.Format;
    switch(format){
      case DXGI_FORMAT_R32G32B32A32_TYPELESS:format=DXGI_FORMAT_R32G32B32A32_FLOAT;break;
      case DXGI_FORMAT_R32G32B32_TYPELESS:format=DXGI_FORMAT_R32G32B32_FLOAT;break;
      case DXGI_FORMAT_R16G16B16A16_TYPELESS:format=DXGI_FORMAT_R16G16B16A16_FLOAT;break;
      case DXGI_FORMAT_R32G32_TYPELESS:format=DXGI_FORMAT_R32G32_FLOAT;break;
      case DXGI_FORMAT_R32G8X24_TYPELESS:case DXGI_FORMAT_D32_FLOAT_S8X24_UINT:format=DXGI_FORMAT_R32_FLOAT_X8X24_TYPELESS;break;
      case DXGI_FORMAT_R10G10B10A2_TYPELESS:format=DXGI_FORMAT_R10G10B10A2_UNORM;break;
      case DXGI_FORMAT_R8G8B8A8_TYPELESS:format=DXGI_FORMAT_R8G8B8A8_UNORM;break;
      case DXGI_FORMAT_R16G16_TYPELESS:format=DXGI_FORMAT_R16G16_FLOAT;break;
      case DXGI_FORMAT_R32_TYPELESS:case DXGI_FORMAT_D32_FLOAT:format=DXGI_FORMAT_R32_FLOAT;break;
      case DXGI_FORMAT_R24G8_TYPELESS:case DXGI_FORMAT_D24_UNORM_S8_UINT:format=DXGI_FORMAT_R24_UNORM_X8_TYPELESS;break;
      case DXGI_FORMAT_R8G8_TYPELESS:format=DXGI_FORMAT_R8G8_UNORM;break;
      case DXGI_FORMAT_R16_TYPELESS:format=DXGI_FORMAT_R16_FLOAT;break;
      case DXGI_FORMAT_R8_TYPELESS:format=DXGI_FORMAT_R8_UNORM;break;
      case DXGI_FORMAT_B8G8R8A8_TYPELESS:format=DXGI_FORMAT_B8G8R8A8_UNORM;break;
      case DXGI_FORMAT_B8G8R8X8_TYPELESS:format=DXGI_FORMAT_B8G8R8X8_UNORM;break;
      case DXGI_FORMAT_D16_UNORM:format=DXGI_FORMAT_R16_UNORM;break;
      default:break;
    }
    D3D11_SHADER_RESOURCE_VIEW_DESC descriptor{};descriptor.Format=format;descriptor.ViewDimension=D3D11_SRV_DIMENSION_TEXTURE2D;descriptor.Texture2D.MipLevels=1;
    const auto result=state.device->CreateShaderResourceView(resource,&descriptor,&view);if(FAILED(result))return result;
    if(state.views.size()>=8)state.views.erase(state.views.begin());state.views.push_back({resource,view});return S_OK;
}
HRESULT transform(Context &state,ID3D11Resource *source,Context::CachedImage &slot,DXGI_FORMAT format,
    unsigned width,unsigned height,ID3D11ComputeShader *shader,const float *constants,ComPtr<ID3D11Texture2D> &output,unsigned dispatchWidth=0,unsigned dispatchHeight=0){
    D3D11_TEXTURE2D_DESC descriptor{};descriptor.Width=width;descriptor.Height=height;descriptor.Format=format;descriptor.SampleDesc.Count=1;descriptor.BindFlags=D3D11_BIND_SHADER_RESOURCE|D3D11_BIND_UNORDERED_ACCESS;
    auto result=scratch(state,slot,descriptor);if(FAILED(result))return failure(state,"GPU guide target creation",result);
    ComPtr<ID3D11ShaderResourceView> input;if(FAILED(result=sourceView(state,source,input)))return failure(state,"GPU guide source view",result);
    ComPtr<ID3D11UnorderedAccessView> target;if(FAILED(result=state.device->CreateUnorderedAccessView(slot.value.Get(),nullptr,&target)))return failure(state,"GPU guide output view",result);
    if(!state.constants){D3D11_BUFFER_DESC buffer{};buffer.ByteWidth=32;buffer.Usage=D3D11_USAGE_DEFAULT;buffer.BindFlags=D3D11_BIND_CONSTANT_BUFFER;if(FAILED(result=state.device->CreateBuffer(&buffer,nullptr,&state.constants)))return result;}
    state.commands->UpdateSubresource(state.constants.Get(),0,nullptr,constants,0,0);auto srv=input.Get();auto uav=target.Get();auto buffer=state.constants.Get();state.commands->CSSetShader(shader,nullptr,0);state.commands->CSSetConstantBuffers(0,1,&buffer);state.commands->CSSetShaderResources(0,1,&srv);state.commands->CSSetUnorderedAccessViews(0,1,&uav,nullptr);state.commands->Dispatch(((dispatchWidth?dispatchWidth:width)+7)/8,((dispatchHeight?dispatchHeight:height)+7)/8,1);
    srv=nullptr;uav=nullptr;state.commands->CSSetShaderResources(0,1,&srv);state.commands->CSSetUnorderedAccessViews(0,1,&uav,nullptr);output=slot.value;return S_OK;
}
}

BOOL WINAPI DllMain(HINSTANCE value,DWORD reason,LPVOID){if(reason==DLL_PROCESS_ATTACH){module=value;DisableThreadLibraryCalls(value);}return TRUE;}
extern "C" void *maclauncherTargets[maclauncherExportCount]{};
extern "C" int maclauncherUnsupportedVendorExtension(){return XESS_RESULT_ERROR_NOT_IMPLEMENTED;}
extern "C" void *maclauncherResolveExport(unsigned index){
    // Intel-private entrypoints have no public contract and cannot consume a
    // replacement context. Preserve exports/ordinals with an explicit failure;
    // forwarding an owned context into Intel's binary would corrupt ownership.
    if(index>=maclauncherExportCount)RaiseException(ERROR_PROC_NOT_FOUND,EXCEPTION_NONCONTINUABLE,0,nullptr);
    auto target=reinterpret_cast<void*>(&maclauncherUnsupportedVendorExtension);
    InterlockedExchangePointer(&maclauncherTargets[index],target);return target;
}

extern "C" {
XESS_API xess_result_t xessGetVersion(xess_version_t *version){if(!version)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*version={2,0,0,0};return XESS_RESULT_SUCCESS;}
XESS_API xess_result_t xessD3D11CreateContext(ID3D11Device *device,xess_context_handle_t *output){
    if(!device||!output)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*output=nullptr;
    try{auto state=std::make_shared<Context>();state->device=device;device->GetImmediateContext(&state->immediate);
        if(FAILED(device->CreateDeferredContext(0,&state->commands))||FAILED(state->commands.As(&state->extension)))return XESS_RESULT_ERROR_UNSUPPORTED_DRIVER;
        BOOL supported=FALSE;if(FAILED(state->extension->CheckFeatureSupport(MTL_FEATURE_METALFX_TEMPORAL_SCALER,&supported,sizeof(supported)))||!supported)return XESS_RESULT_ERROR_UNSUPPORTED_DEVICE;
        const auto handle=reinterpret_cast<xess_context_handle_t>(state.get());{std::lock_guard lock(contextsMutex);contexts.emplace(handle,state);}*output=handle;return XESS_RESULT_SUCCESS;
    }catch(const std::bad_alloc&){return XESS_RESULT_ERROR_DEVICE_OUT_OF_MEMORY;}catch(...){return XESS_RESULT_ERROR_DEVICE;}
}
XESS_API xess_result_t xessDestroyContext(xess_context_handle_t handle){std::lock_guard lock(contextsMutex);return contexts.erase(handle)?XESS_RESULT_SUCCESS:XESS_RESULT_ERROR_INVALID_CONTEXT;}
XESS_API xess_result_t xessD3D11Init(xess_context_handle_t handle,const xess_d3d11_init_params_t *parameters){return use(handle,[&](Context &state){
    if(!parameters||!extent(parameters->outputResolution)||ratio(parameters->qualitySetting,state.legacy)==0||parameters->initFlags&~511u)return XESS_RESULT_ERROR_INVALID_ARGUMENT;
    // Responsive masks need the extended native guide contract. D3D11 has no
    // external descriptor heaps, as specified by the public XeSS contract.
    if(parameters->initFlags&XESS_INIT_FLAG_EXTERNAL_DESCRIPTOR_HEAP)return XESS_RESULT_ERROR_UNSUPPORTED;
    if(parameters->initFlags&XESS_INIT_FLAG_RESPONSIVE_PIXEL_MASK){BOOL supported=FALSE;if(FAILED(state.extension->CheckFeatureSupport(MTL_FEATURE(MLTemporalReactiveFeature),&supported,sizeof(supported)))||!supported)return XESS_RESULT_ERROR_UNSUPPORTED;}
    state.init=*parameters;state.initialized=true;state.color={};state.depth={};state.motion={};state.output={};state.exposureImage={};state.normalizedMotion={};state.responsiveImage={};state.responsiveCrop={};state.views.clear();state.motionHistory=false;return XESS_RESULT_SUCCESS;
});}
XESS_API xess_result_t xessD3D11GetInitParams(xess_context_handle_t handle,xess_d3d11_init_params_t *parameters){return use(handle,[&](Context &state){if(!parameters)return XESS_RESULT_ERROR_INVALID_ARGUMENT;if(!state.initialized)return XESS_RESULT_ERROR_UNINITIALIZED;*parameters=state.init;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessD3D11Execute(xess_context_handle_t handle,const xess_d3d11_execute_params_t *parameters){return use(handle,[&](Context &state){
    if(!state.initialized)return XESS_RESULT_ERROR_UNINITIALIZED;
    if(!parameters||!parameters->inputWidth||!parameters->inputHeight||parameters->reserved0.x||parameters->reserved0.y||!std::isfinite(parameters->jitterOffsetX)||!std::isfinite(parameters->jitterOffsetY)||!std::isfinite(parameters->exposureScale)||parameters->exposureScale<=0)return XESS_RESULT_ERROR_INVALID_ARGUMENT;
    if(!parameters->pDepthTexture)return XESS_RESULT_ERROR_UNSUPPORTED;
    struct Recording {Context &state;bool submitted=false;~Recording(){if(!submitted){ComPtr<ID3D11CommandList> discard;state.commands->FinishCommandList(FALSE,&discard);}}} recording{state};
    const uint32_t width=parameters->inputWidth,height=parameters->inputHeight;
    if(width>state.init.outputResolution.x||height>state.init.outputResolution.y||uint64_t(width)*3<state.init.outputResolution.x||uint64_t(height)*3<state.init.outputResolution.y)return XESS_RESULT_ERROR_UNSUPPORTED;
    ComPtr<ID3D11Texture2D> color,depth,motion,output;D3D11_TEXTURE2D_DESC outputDescription{};
    xess_result_t result;
    const bool high=state.init.initFlags&XESS_INIT_FLAG_HIGH_RES_MV;
    D3D11_TEXTURE2D_DESC colorAllocation{},depthAllocation{},motionAllocation{};ComPtr<ID3D11Texture2D> inspected;
    const bool preserve=!parameters->inputColorBase.x&&!parameters->inputColorBase.y&&!parameters->inputDepthBase.x&&!parameters->inputDepthBase.y&&
        texture(parameters->pColorTexture,inspected,colorAllocation)&&texture(parameters->pDepthTexture,inspected,depthAllocation)&&texture(parameters->pVelocityTexture,inspected,motionAllocation)&&
        colorAllocation.Width==depthAllocation.Width&&colorAllocation.Height==depthAllocation.Height&&colorAllocation.Width<=state.init.outputResolution.x&&colorAllocation.Height<=state.init.outputResolution.y&&
        (high?colorAllocation.Width==width&&colorAllocation.Height==height:!parameters->inputMotionVectorBase.x&&!parameters->inputMotionVectorBase.y&&colorAllocation.Width==motionAllocation.Width&&colorAllocation.Height==motionAllocation.Height);
    if((result=crop(state,parameters->pColorTexture,parameters->inputColorBase,width,height,state.color,color,preserve))!=XESS_RESULT_SUCCESS)return result;
    if((result=crop(state,parameters->pDepthTexture,parameters->inputDepthBase,width,height,state.depth,depth,preserve))!=XESS_RESULT_SUCCESS)return result;
    if((result=crop(state,parameters->pVelocityTexture,parameters->inputMotionVectorBase,high?state.init.outputResolution.x:width,high?state.init.outputResolution.y:height,state.motion,motion,preserve&&!high))!=XESS_RESULT_SUCCESS)return result;
    if(!texture(parameters->pOutputTexture,output,outputDescription)||uint64_t(parameters->outputColorBase.x)+state.init.outputResolution.x>outputDescription.Width||uint64_t(parameters->outputColorBase.y)+state.init.outputResolution.y>outputDescription.Height)return XESS_RESULT_ERROR_INVALID_ARGUMENT;
    const bool copyOutput=parameters->outputColorBase.x||parameters->outputColorBase.y||outputDescription.Width!=state.init.outputResolution.x||outputDescription.Height!=state.init.outputResolution.y;
    if(copyOutput){outputDescription.Width=state.init.outputResolution.x;outputDescription.Height=state.init.outputResolution.y;if(FAILED(scratch(state,state.output,outputDescription)))return XESS_RESULT_ERROR_DEVICE_OUT_OF_MEMORY;output=state.output.value;}
    const bool textureExposure=state.init.initFlags&XESS_INIT_FLAG_EXPOSURE_SCALE_TEXTURE;
    ComPtr<ID3D11Texture2D> exposure;
    if(textureExposure){D3D11_TEXTURE2D_DESC description{};if(!texture(parameters->pExposureScaleTexture,exposure,description)||description.Width!=1||description.Height!=1)return XESS_RESULT_ERROR_INVALID_ARGUMENT;
        if(description.Format!=DXGI_FORMAT_R16_FLOAT){
            static const char program[]="Texture2D<float4> src:register(t0);RWTexture2D<float> dst:register(u0);cbuffer Meta:register(b0){float4 meta;}[numthreads(8,8,1)]void main(uint3 p:SV_DispatchThreadID){if(p.x==0&&p.y==0)dst[uint2(0,0)]=src.Load(int3(0,0,0)).x;}";
            const float constants[8]={};if(FAILED(shader(state,state.exposureShader,program))||FAILED(transform(state,exposure.Get(),state.exposureImage,DXGI_FORMAT_R16_FLOAT,1,1,state.exposureShader.Get(),constants,exposure)))return XESS_RESULT_ERROR_DEVICE;
        }
    }
    MTL_TEMPORAL_UPSCALE_D3D11_DESC descriptor{};descriptor.InputContentWidth=width;descriptor.InputContentHeight=height;descriptor.InReset=parameters->resetHistory;
    descriptor.Color=color.Get();descriptor.Depth=depth.Get();descriptor.MotionVector=motion.Get();descriptor.Output=output.Get();descriptor.DepthReversed=state.init.initFlags&XESS_INIT_FLAG_INVERTED_DEPTH;descriptor.AutoExposure=state.init.initFlags&XESS_INIT_FLAG_ENABLE_AUTOEXPOSURE;descriptor.MotionVectorInDisplayRes=high;
    descriptor.JitterOffsetX=parameters->jitterOffsetX*state.jitterX;descriptor.JitterOffsetY=parameters->jitterOffsetY*state.jitterY;
    descriptor.MotionVectorScaleX=state.velocityX;descriptor.MotionVectorScaleY=state.velocityY;
    if(state.init.initFlags&XESS_INIT_FLAG_USE_NDC_VELOCITY){descriptor.MotionVectorScaleX*=float(high?state.init.outputResolution.x:width)*.5f;descriptor.MotionVectorScaleY*=float(high?state.init.outputResolution.y:height)*-.5f;}
    if(state.init.initFlags&XESS_INIT_FLAG_JITTERED_MV){
        static const char program[]="Texture2D<float4> src:register(t0);RWTexture2D<float2> dst:register(u0);cbuffer Meta:register(b0){float2 scale;float2 bias;float2 extent;float2 unused;}[numthreads(8,8,1)]void main(uint3 p:SV_DispatchThreadID){if(p.x<extent.x&&p.y<extent.y)dst[p.xy]=src.Load(int3(p.xy,0)).xy*scale+bias;}";
        const bool reset=parameters->resetHistory||!state.motionHistory;
        const float constants[]={descriptor.MotionVectorScaleX,descriptor.MotionVectorScaleY,
            reset?0.f:(state.previousJitterX-descriptor.JitterOffsetX)*(high?float(state.init.outputResolution.x)/width:1),
            reset?0.f:(state.previousJitterY-descriptor.JitterOffsetY)*(high?float(state.init.outputResolution.y)/height:1),
            float(high?state.init.outputResolution.x:width),float(high?state.init.outputResolution.y:height),0,0};
        ComPtr<ID3D11Texture2D> normalized;if(FAILED(shader(state,state.motionShader,program))||FAILED(transform(state,motion.Get(),state.normalizedMotion,DXGI_FORMAT_R32G32_FLOAT,high?state.init.outputResolution.x:preserve?colorAllocation.Width:width,high?state.init.outputResolution.y:preserve?colorAllocation.Height:height,state.motionShader.Get(),constants,normalized,high?state.init.outputResolution.x:width,high?state.init.outputResolution.y:height)))return XESS_RESULT_ERROR_DEVICE;
        motion=normalized;descriptor.MotionVector=motion.Get();descriptor.MotionVectorScaleX=descriptor.MotionVectorScaleY=1;
    }
    // XeSS chooses one exposure source. Its explicit scalar is ignored when
    // texture or automatic exposure is selected; the independent multiplier
    // remains active in every mode.
    descriptor.PreExposure=1/((textureExposure||descriptor.AutoExposure?1:parameters->exposureScale)*state.exposure);descriptor.ExposureTexture=exposure.Get();
    ComPtr<ID3D11Texture2D> responsive;
    if(state.init.initFlags&XESS_INIT_FLAG_RESPONSIVE_PIXEL_MASK){
        const auto cropped=crop(state,parameters->pResponsivePixelMaskTexture,parameters->inputResponsiveMaskBase,width,height,state.responsiveCrop,responsive);if(cropped!=XESS_RESULT_SUCCESS)return cropped;
        static const char program[]="Texture2D<float4> src:register(t0);RWTexture2D<float> dst:register(u0);cbuffer Meta:register(b0){float maximum;float3 unused;float2 extent;float2 padding;}[numthreads(8,8,1)]void main(uint3 p:SV_DispatchThreadID){if(p.x<extent.x&&p.y<extent.y)dst[p.xy]=clamp(src.Load(int3(p.xy,0)).x,0,maximum);}";
        const float constants[]={state.maxResponsive,0,0,0,float(width),float(height),0,0};ComPtr<ID3D11Texture2D> normalized;
        if(FAILED(shader(state,state.responsiveShader,program))||FAILED(transform(state,responsive.Get(),state.responsiveImage,DXGI_FORMAT_R16_FLOAT,preserve?colorAllocation.Width:width,preserve?colorAllocation.Height:height,state.responsiveShader.Get(),constants,normalized,width,height)))return XESS_RESULT_ERROR_DEVICE;responsive=normalized;
    }
    MLTemporalAux auxiliary{};auxiliary.reactiveMask=responsive.Get();MLScopedContextAux auxiliaryScope(state.commands.Get(),auxiliary);
    state.extension->TemporalUpscale(&descriptor);
    HRESULT encoded=S_OK;UINT resultBytes=sizeof(encoded);if(SUCCEEDED(state.commands->GetPrivateData(MLTemporalResultGuid,&resultBytes,&encoded))&&(resultBytes!=sizeof(encoded)||FAILED(encoded)))return XESS_RESULT_ERROR_DEVICE;
    if(copyOutput){D3D11_BOX box{0,0,0,state.init.outputResolution.x,state.init.outputResolution.y,1};state.commands->CopySubresourceRegion(parameters->pOutputTexture,0,parameters->outputColorBase.x,parameters->outputColorBase.y,0,output.Get(),0,&box);}
    ComPtr<ID3D11CommandList> list;if(FAILED(state.commands->FinishCommandList(FALSE,&list)))return XESS_RESULT_ERROR_DEVICE;
    state.immediate->ExecuteCommandList(list.Get(),TRUE);recording.submitted=true;state.previousJitterX=descriptor.JitterOffsetX;state.previousJitterY=descriptor.JitterOffsetY;state.motionHistory=true;return XESS_RESULT_SUCCESS;
});}
XESS_API xess_result_t xessGetIntelXeFXVersion(xess_context_handle_t handle,xess_version_t *version){return use(handle,[&](Context&){if(!version)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*version={};return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessGetProperties(xess_context_handle_t handle,const xess_2d_t *output,xess_properties_t *properties){return use(handle,[&](Context&){if(!output||!extent(*output)||!properties)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*properties={};return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessGetInputResolution(xess_context_handle_t handle,const xess_2d_t *output,xess_quality_settings_t quality,xess_2d_t *input){return use(handle,[&](Context &state){return inputResolution(state,output,quality,input);});}
XESS_API xess_result_t xessGetOptimalInputResolution(xess_context_handle_t handle,const xess_2d_t *output,xess_quality_settings_t quality,xess_2d_t *optimal,xess_2d_t *minimum,xess_2d_t *maximum){return use(handle,[&](Context &state){if(!minimum||!maximum)return XESS_RESULT_ERROR_INVALID_ARGUMENT;const auto result=inputResolution(state,output,quality,optimal);if(result!=XESS_RESULT_SUCCESS)return result;*minimum={std::max(1u,(output->x+2)/3),std::max(1u,(output->y+2)/3)};*maximum=*output;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessGetJitterScale(xess_context_handle_t handle,float *x,float *y){return use(handle,[&](Context &state){if(!x||!y)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*x=state.jitterX;*y=state.jitterY;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessSetJitterScale(xess_context_handle_t handle,float x,float y){return use(handle,[&](Context &state){if(!std::isfinite(x)||!std::isfinite(y))return XESS_RESULT_ERROR_INVALID_ARGUMENT;state.jitterX=x;state.jitterY=y;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessGetVelocityScale(xess_context_handle_t handle,float *x,float *y){return use(handle,[&](Context &state){if(!x||!y)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*x=state.velocityX;*y=state.velocityY;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessSetVelocityScale(xess_context_handle_t handle,float x,float y){return use(handle,[&](Context &state){if(!std::isfinite(x)||!std::isfinite(y))return XESS_RESULT_ERROR_INVALID_ARGUMENT;state.velocityX=x;state.velocityY=y;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessSetExposureMultiplier(xess_context_handle_t handle,float value){return use(handle,[&](Context &state){if(!std::isfinite(value)||value<=0)return XESS_RESULT_ERROR_INVALID_ARGUMENT;state.exposure=value;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessGetExposureMultiplier(xess_context_handle_t handle,float *value){return use(handle,[&](Context &state){if(!value)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*value=state.exposure;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessSetMaxResponsiveMaskValue(xess_context_handle_t handle,float value){return use(handle,[&](Context &state){if(!std::isfinite(value)||value<0||value>1)return XESS_RESULT_ERROR_INVALID_ARGUMENT;state.maxResponsive=value;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessGetMaxResponsiveMaskValue(xess_context_handle_t handle,float *value){return use(handle,[&](Context &state){if(!value)return XESS_RESULT_ERROR_INVALID_ARGUMENT;*value=state.maxResponsive;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessSetLoggingCallback(xess_context_handle_t handle,xess_logging_level_t level,xess_app_log_callback_t callback){return use(handle,[&](Context &state){if(level<XESS_LOGGING_LEVEL_DEBUG||level>XESS_LOGGING_LEVEL_ERROR)return XESS_RESULT_ERROR_INVALID_ARGUMENT;state.logging=level;state.logger=callback;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessIsOptimalDriver(xess_context_handle_t handle){return use(handle,[](Context &state){BOOL supported=FALSE;return SUCCEEDED(state.extension->CheckFeatureSupport(MTL_FEATURE_METALFX_TEMPORAL_SCALER,&supported,sizeof(supported)))&&supported?XESS_RESULT_SUCCESS:XESS_RESULT_ERROR_UNSUPPORTED_DRIVER;});}
XESS_API xess_result_t xessForceLegacyScaleFactors(xess_context_handle_t handle,bool force){return use(handle,[&](Context &state){state.legacy=force;return XESS_RESULT_SUCCESS;});}
XESS_API xess_result_t xessGetPipelineBuildStatus(xess_context_handle_t handle){return use(handle,[](Context&){return XESS_RESULT_ERROR_WRONG_CALL_ORDER;});}
}
