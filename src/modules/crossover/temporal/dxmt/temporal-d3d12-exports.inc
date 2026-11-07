// Copyright (c) MacLauncher contributors. MIT license.
extern "C" __declspec(dllexport) HRESULT WINAPI MacLauncherDXMTTemporalUpscale12(ID3D12GraphicsCommandList*commands,const MLTemporalD3D12*input,void**history){
 if(!commands||!input)return E_INVALIDARG;
 try{return static_cast<MTLD3D12GraphicsCommandListImpl*>(commands)->mlRecordTemporal12(*input,history);}
 catch(const std::bad_alloc&){return E_OUTOFMEMORY;}catch(...){return E_FAIL;}
}
extern "C" __declspec(dllexport) void WINAPI MacLauncherDXMTReleaseTemporal12(void*history){delete static_cast<MLTemporal12History*>(history);}
extern "C" __declspec(dllexport) BOOL WINAPI MacLauncherDXMTTemporal12Supported(ID3D12Device*device){return device&&static_cast<MTLD3D12Device*>(device)->GetMTLDevice().supportsFXTemporalScaler();}
