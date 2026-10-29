// Copyright (c) MacLauncher contributors. MIT license.
#include "xess-protocol.h"
#include <d3d12.h>
#include <dxgi1_4.h>
#include <wrl/client.h>
#include <xess/xess.h>
#include <xess/xess_d3d12.h>
#include <array>
#include <memory>
#include <string>
#include <stdexcept>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <atomic>
using Microsoft::WRL::ComPtr;
namespace {
void check(HRESULT result,const char *operation){if(FAILED(result)){char text[256];std::snprintf(text,sizeof(text),"%s failed (0x%08lx)",operation,(unsigned long)result);throw std::runtime_error(text);}}
void checkXeSS(xess_result_t result,const char *operation){if(result!=XESS_RESULT_SUCCESS){char text[256];std::snprintf(text,sizeof(text),"%s returned %d",operation,int(result));throw std::runtime_error(text);}}
std::wstring windowsPath(const char *path){std::string value=path;if(!value.empty()&&value[0]=='/')value="Z:"+value;int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,value.data(),int(value.size()),nullptr,0);if(!count)throw std::runtime_error("The XeSS library path is invalid");std::wstring result(count,L'\0');MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,value.data(),int(value.size()),result.data(),count);return result;}
struct API {
    HMODULE library=nullptr;
    decltype(&xessD3D12CreateContext) create;
    decltype(&xessD3D12BuildPipelines) build;
    decltype(&xessD3D12Init) init;
    decltype(&xessD3D12Execute) execute;
    decltype(&xessDestroyContext) destroy;
    decltype(&xessGetProperties) properties;
    explicit API(const char *file){library=LoadLibraryW(windowsPath(file).c_str());if(!library)throw std::runtime_error("The original Intel XeSS runtime could not be loaded");
#define LOAD(member,name) member=reinterpret_cast<decltype(member)>(GetProcAddress(library,#name));if(!member)throw std::runtime_error("The selected Intel XeSS runtime is missing " #name)
        LOAD(create,xessD3D12CreateContext);LOAD(build,xessD3D12BuildPipelines);LOAD(init,xessD3D12Init);LOAD(execute,xessD3D12Execute);LOAD(destroy,xessDestroyContext);LOAD(properties,xessGetProperties);
#undef LOAD
    }
};
struct Image {ComPtr<ID3D12Resource> texture,transfer;D3D12_PLACED_SUBRESOURCE_FOOTPRINT footprint{};MLXessMapping mapping{};};
struct Host;
struct Completion {Host *host;MLXessCall call;HANDLE event=nullptr,registration=nullptr;};
struct Slot {std::array<Image,5> images;ComPtr<ID3D12CommandAllocator> allocator;ComPtr<ID3D12GraphicsCommandList> commands;ComPtr<ID3D12Resource> timestamps;uint64_t *timeData=nullptr;HANDLE submitted=nullptr,done=nullptr;std::atomic<Completion*> pending{nullptr};};
struct Host {
    API api;MLXessBridge bridge;ComPtr<ID3D12Device> device;ComPtr<ID3D12CommandQueue> queue;ComPtr<ID3D12Fence> fence;ComPtr<ID3D12QueryHeap> queries;
    xess_context_handle_t context=nullptr;MLXessCall configuration{};std::array<Slot,ML_XESS_SLOTS> slots;uint64_t nextFence=0,frequency=0;std::mutex completionPublication;
    Host(const char *library,MLXessBridge bridge):api(library),bridge(bridge){
        ComPtr<IDXGIFactory4> factory;check(CreateDXGIFactory1(IID_PPV_ARGS(&factory)),"D3D12 adapter enumeration");ComPtr<IDXGIAdapter1> adapter;check(factory->EnumAdapters1(0,&adapter),"D3D12 adapter selection");check(D3D12CreateDevice(adapter.Get(),D3D_FEATURE_LEVEL_12_0,IID_PPV_ARGS(&device)),"D3D12 GPU creation");
        D3D12_COMMAND_QUEUE_DESC descriptor{};check(device->CreateCommandQueue(&descriptor,IID_PPV_ARGS(&queue)),"D3D12 inference queue");check(queue->GetTimestampFrequency(&frequency),"D3D12 GPU timestamp frequency");check(device->CreateFence(0,D3D12_FENCE_FLAG_NONE,IID_PPV_ARGS(&fence)),"D3D12 inference fence");D3D12_QUERY_HEAP_DESC query{};query.Type=D3D12_QUERY_HEAP_TYPE_TIMESTAMP;query.Count=ML_XESS_SLOTS*4;check(device->CreateQueryHeap(&query,IID_PPV_ARGS(&queries)),"D3D12 GPU profiling");
    }
    void buffer(ComPtr<ID3D12Resource> &resource,uint64_t bytes,D3D12_HEAP_TYPE type,D3D12_RESOURCE_STATES state){D3D12_HEAP_PROPERTIES heap{};heap.Type=type;D3D12_RESOURCE_DESC descriptor{};descriptor.Dimension=D3D12_RESOURCE_DIMENSION_BUFFER;descriptor.Width=bytes;descriptor.Height=1;descriptor.DepthOrArraySize=descriptor.MipLevels=1;descriptor.SampleDesc.Count=1;descriptor.Layout=D3D12_TEXTURE_LAYOUT_ROW_MAJOR;check(device->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&descriptor,state,nullptr,IID_PPV_ARGS(&resource)),"D3D12 shared transfer allocation");}
    void configure(MLXessCall &call){
        if(context)throw std::runtime_error("The XeSS owner cannot be reconfigured while commands remain retained");
        if(!call.inputWidth||!call.inputHeight||!call.outputWidth||!call.outputHeight||call.inputWidth>16384||call.inputHeight>16384||call.outputWidth>16384||call.outputHeight>16384)throw std::runtime_error("The XeSS image dimensions are invalid");
        configuration=call;checkXeSS(api.create(device.Get(),&context),"Intel XeSS context creation");
        xess_properties_t properties{};xess_2d_t output{call.outputWidth,call.outputHeight};checkXeSS(api.properties(context,&output,&properties),"Intel XeSS resource query");
        uint64_t estimate=properties.tempBufferHeapSize+properties.tempTextureHeapSize;
        for(unsigned i=0;i<5;++i){D3D12_RESOURCE_DESC description{};description.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;description.Width=i==4?call.outputWidth:call.inputWidth;description.Height=i==4?call.outputHeight:call.inputHeight;description.DepthOrArraySize=description.MipLevels=1;description.SampleDesc.Count=1;const DXGI_FORMAT formats[]={DXGI_FORMAT_R16G16B16A16_FLOAT,DXGI_FORMAT_R32G32_FLOAT,DXGI_FORMAT_R32_FLOAT,DXGI_FORMAT_R16_FLOAT,DXGI_FORMAT_R16G16B16A16_FLOAT};description.Format=formats[i];description.Flags=i==4?D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS:D3D12_RESOURCE_FLAG_NONE;uint64_t bytes=0;device->GetCopyableFootprints(&description,0,1,0,nullptr,nullptr,nullptr,&bytes);estimate+=ML_XESS_SLOTS*(((bytes+65535)&~uint64_t(65535))+device->GetResourceAllocationInfo(0,1,&description).SizeInBytes);}estimate+=ML_XESS_SLOTS*65536;
        call.allocationBytes=estimate;call.status=2;check(bridge(ML_XESS_READY,&call),"XeSS allocation admission query");MLXessCall admitted{};admitted.size=sizeof(admitted);admitted.version=ML_XESS_VERSION;check(bridge(ML_XESS_NEXT,&admitted),"XeSS allocation admission");if(admitted.command!=ML_XESS_ADMIT)throw std::runtime_error("XeSS allocation admission was cancelled");
        checkXeSS(api.build(context,nullptr,true,call.flags),"Intel XeSS pipeline compilation");xess_d3d12_init_params_t init{};init.outputResolution=output;init.qualitySetting=XESS_QUALITY_SETTING_ULTRA_PERFORMANCE;init.initFlags=call.flags;checkXeSS(api.init(context,&init),"Intel XeSS initialization");
        uint64_t allocation=properties.tempBufferHeapSize+properties.tempTextureHeapSize;
        for(unsigned index=0;index<ML_XESS_SLOTS;++index){auto &slot=slots[index];check(device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,IID_PPV_ARGS(&slot.allocator)),"D3D12 allocator");check(device->CreateCommandList(0,D3D12_COMMAND_LIST_TYPE_DIRECT,slot.allocator.Get(),nullptr,IID_PPV_ARGS(&slot.commands)),"D3D12 command list");check(slot.commands->Close(),"D3D12 initial command list");
            for(unsigned image=0;image<5;++image){bool outputImage=image==4;auto &target=slot.images[image];D3D12_RESOURCE_DESC description{};description.Dimension=D3D12_RESOURCE_DIMENSION_TEXTURE2D;description.Width=outputImage?call.outputWidth:call.inputWidth;description.Height=outputImage?call.outputHeight:call.inputHeight;description.DepthOrArraySize=description.MipLevels=1;description.SampleDesc.Count=1;const DXGI_FORMAT formats[]={DXGI_FORMAT_R16G16B16A16_FLOAT,DXGI_FORMAT_R32G32_FLOAT,DXGI_FORMAT_R32_FLOAT,DXGI_FORMAT_R16_FLOAT,DXGI_FORMAT_R16G16B16A16_FLOAT};description.Format=formats[image];description.Flags=outputImage?D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS:D3D12_RESOURCE_FLAG_NONE;D3D12_HEAP_PROPERTIES heap{};heap.Type=D3D12_HEAP_TYPE_DEFAULT;check(device->CreateCommittedResource(&heap,D3D12_HEAP_FLAG_NONE,&description,outputImage?D3D12_RESOURCE_STATE_UNORDERED_ACCESS:D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,nullptr,IID_PPV_ARGS(&target.texture)),"D3D12 scene image");
                uint64_t bytes=0;device->GetCopyableFootprints(&description,0,1,0,&target.footprint,nullptr,nullptr,&bytes);bytes=(bytes+65535)&~uint64_t(65535);buffer(target.transfer,bytes,outputImage?D3D12_HEAP_TYPE_READBACK:D3D12_HEAP_TYPE_UPLOAD,outputImage?D3D12_RESOURCE_STATE_COPY_DEST:D3D12_RESOURCE_STATE_GENERIC_READ);void *address=nullptr;check(target.transfer->Map(0,nullptr,&address),"D3D12 persistent mapping");target.mapping={reinterpret_cast<uint64_t>(address),bytes,target.footprint.Footprint.RowPitch,0};allocation+=bytes+device->GetResourceAllocationInfo(0,1,&description).SizeInBytes;
            }
            buffer(slot.timestamps,65536,D3D12_HEAP_TYPE_READBACK,D3D12_RESOURCE_STATE_COPY_DEST);check(slot.timestamps->Map(0,nullptr,reinterpret_cast<void**>(&slot.timeData)),"D3D12 timestamp mapping");allocation+=65536;
            MLXessCall bound=call;bound.slot=index;for(unsigned image=0;image<5;++image)bound.mappings[image]=slot.images[image].mapping;check(bridge(ML_XESS_BIND,&bound),"Metal alias-buffer binding");
            slot.submitted=CreateEventW(nullptr,FALSE,FALSE,nullptr);slot.done=CreateEventW(nullptr,FALSE,FALSE,nullptr);if(!slot.submitted||!slot.done)throw std::runtime_error("Cannot prepare XeSS fence notification workers");
            std::thread([this,index]{auto &owned=slots[index];for(;;){if(WaitForSingleObject(owned.submitted,INFINITE)!=WAIT_OBJECT_0)ExitProcess(5);if(WaitForSingleObject(owned.done,INFINITE)!=WAIT_OBJECT_0)ExitProcess(5);auto *work=owned.pending.exchange(nullptr,std::memory_order_acquire);if(!work)ExitProcess(5);completed(work,FALSE);}}).detach();
        }
        call.allocationBytes=allocation;
    }
    static void CALLBACK completed(void *pointer,BOOLEAN timedOut){std::unique_ptr<Completion> completion(static_cast<Completion*>(pointer));auto &host=*completion->host;std::lock_guard publication(host.completionPublication);auto &call=completion->call;auto &slot=host.slots[call.slot];
        if(FAILED(host.device->GetDeviceRemovedReason())||host.fence->GetCompletedValue()==UINT64_MAX)ExitProcess(5);
        if(timedOut){ExitProcess(5);}else{
            const bool valid=host.frequency&&slot.timeData[3]>slot.timeData[0]&&slot.timeData[1]>=slot.timeData[0]&&slot.timeData[2]>=slot.timeData[1]&&slot.timeData[3]>=slot.timeData[2];const double scale=host.frequency?1000.0/host.frequency:0;call.inputCopyMs=valid?((slot.timeData[1]-slot.timeData[0])+(slot.timeData[3]-slot.timeData[2]))*scale:-1;call.inferenceMs=valid?(slot.timeData[2]-slot.timeData[1])*scale:-1;
            if(host.bridge(ML_XESS_EGRESS,&call)){std::snprintf(call.message,sizeof(call.message),"XeSS GPU output could not be published");host.bridge(ML_XESS_FAILURE,&call);}
        }
        if(completion->registration)UnregisterWaitEx(completion->registration,nullptr);if(completion->event)CloseHandle(completion->event);
    }
    void encode(MLXessCall call){if(call.slot>=ML_XESS_SLOTS)throw std::runtime_error("The XeSS image lease is invalid");auto &slot=slots[call.slot];check(bridge(ML_XESS_INGRESS,&call),"Metal scene copy completion");check(slot.allocator->Reset(),"D3D12 allocator reset");check(slot.commands->Reset(slot.allocator.Get(),nullptr),"D3D12 command reset");auto commands=slot.commands.Get();const unsigned base=call.slot*4;commands->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,base);
        auto transition=[&](ID3D12Resource *image,D3D12_RESOURCE_STATES before,D3D12_RESOURCE_STATES after){D3D12_RESOURCE_BARRIER barrier{};barrier.Type=D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;barrier.Transition={image,D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES,before,after};commands->ResourceBarrier(1,&barrier);};
        for(unsigned i=0;i<4;++i){if(i==3&&!(configuration.flags&XESS_INIT_FLAG_RESPONSIVE_PIXEL_MASK))continue;auto &image=slot.images[i];transition(image.texture.Get(),D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE,D3D12_RESOURCE_STATE_COPY_DEST);D3D12_TEXTURE_COPY_LOCATION source{};source.pResource=image.transfer.Get();source.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;source.PlacedFootprint=image.footprint;D3D12_TEXTURE_COPY_LOCATION target{};target.pResource=image.texture.Get();target.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;commands->CopyTextureRegion(&target,0,0,0,&source,nullptr);transition(image.texture.Get(),D3D12_RESOURCE_STATE_COPY_DEST,D3D12_RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE);}
        commands->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,base+1);xess_d3d12_execute_params_t frame{};frame.pColorTexture=slot.images[0].texture.Get();frame.pVelocityTexture=slot.images[1].texture.Get();frame.pDepthTexture=slot.images[2].texture.Get();frame.pResponsivePixelMaskTexture=configuration.flags&XESS_INIT_FLAG_RESPONSIVE_PIXEL_MASK?slot.images[3].texture.Get():nullptr;frame.pOutputTexture=slot.images[4].texture.Get();frame.inputWidth=configuration.inputWidth;frame.inputHeight=configuration.inputHeight;frame.jitterOffsetX=call.jitterX;frame.jitterOffsetY=call.jitterY;frame.exposureScale=1;frame.resetHistory=call.reset;checkXeSS(api.execute(context,commands,&frame),"Intel XeSS execution");commands->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,base+2);
        auto &output=slot.images[4];transition(output.texture.Get(),D3D12_RESOURCE_STATE_UNORDERED_ACCESS,D3D12_RESOURCE_STATE_COPY_SOURCE);D3D12_TEXTURE_COPY_LOCATION source{};source.pResource=output.texture.Get();source.Type=D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;D3D12_TEXTURE_COPY_LOCATION target{};target.pResource=output.transfer.Get();target.Type=D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;target.PlacedFootprint=output.footprint;commands->CopyTextureRegion(&target,0,0,0,&source,nullptr);transition(output.texture.Get(),D3D12_RESOURCE_STATE_COPY_SOURCE,D3D12_RESOURCE_STATE_UNORDERED_ACCESS);commands->EndQuery(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,base+3);commands->ResolveQueryData(queries.Get(),D3D12_QUERY_TYPE_TIMESTAMP,base,4,slot.timestamps.Get(),0);check(commands->Close(),"D3D12 scene command completion");
        auto completion=std::make_unique<Completion>();completion->host=this;completion->call=call;ID3D12CommandList *batch[]={commands};queue->ExecuteCommandLists(1,batch);const auto value=++nextFence;
        // After submission, losing completion authority retires this process.
        // A failure reply must never make the caller recycle an in-flight image.
        if(FAILED(queue->Signal(fence.Get(),value))||FAILED(fence->SetEventOnCompletion(value,slot.done)))ExitProcess(5);
        slot.pending.store(completion.release(),std::memory_order_release);if(!SetEvent(slot.submitted))ExitProcess(5);
    }
};
}
int main(int argc,char **argv){if(argc!=3&&argc!=4)return 2;try{auto module=LoadLibraryW(L"maclauncher-xess-gpu.dll");if(!module)return 3;auto bridge=reinterpret_cast<MLXessBridge>(GetProcAddress(module,"mlXessBridge"));if(!bridge)return 3;MLXessCall call{};call.size=sizeof(call);call.version=ML_XESS_VERSION;std::snprintf(call.endpoint,sizeof(call.endpoint),"%s",argv[1]);if(argc==4)std::snprintf(call.message,sizeof(call.message),"%s",argv[3]);const auto initialized=bridge(ML_XESS_INIT,&call);if(initialized){if(call.message[0]&&(argc!=4||std::strcmp(call.message,argv[3])))throw std::runtime_error(call.message);check(initialized,"XeSS native service handshake");}
    if(argc==4){std::printf("MACLAUNCHER_XESS_HELPER {\"pid\":%d,\"token\":\"%s\"}\n",call.process,argv[3]);std::fflush(stdout);std::thread([]{for(;;){Sleep(1000);DWORD written=0;const char alive[]="MACLAUNCHER_GPU_ALIVE\n";if(!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),alive,sizeof(alive)-1,&written,nullptr))ExitProcess(0);}}).detach();}auto host=new Host(argv[2],bridge);for(;;){call={};call.size=sizeof(call);call.version=ML_XESS_VERSION;check(bridge(ML_XESS_NEXT,&call),"XeSS scene admission");if(call.command==ML_XESS_CLOSE)return 0;try{if(call.command==ML_XESS_CONFIGURE){host->configure(call);call.status=0;bridge(ML_XESS_READY,&call);}else if(call.command==ML_XESS_FRAME)host->encode(call);}catch(const std::exception &error){call.status=-1;std::snprintf(call.message,sizeof(call.message),"%s",error.what());bridge(call.command==ML_XESS_CONFIGURE?ML_XESS_READY:ML_XESS_FAILURE,&call);}}
}catch(const std::exception &error){std::fprintf(stderr,"%s\n",error.what());return 4;}}
