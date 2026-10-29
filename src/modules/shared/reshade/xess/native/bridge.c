// Copyright (c) MacLauncher contributors. MIT license.
// Wine's Unix-library boundary preserves its native dispatcher and PE ABI.
#include "xess-protocol.h"
static uint64_t unixHandle;
typedef LONG (WINAPI *QueryMemory)(HANDLE,const void*,unsigned,void*,SIZE_T,SIZE_T*);
typedef LONG (WINAPI *UnixCall)(uint64_t,unsigned,void*);
static UnixCall dispatcher;
BOOL WINAPI DllMain(HINSTANCE module,DWORD reason,void*reserved){
    if(reason!=DLL_PROCESS_ATTACH)return TRUE;
    DisableThreadLibraryCalls(module);
    HMODULE ntdll=GetModuleHandleW(L"ntdll.dll");
    QueryMemory query=(QueryMemory)GetProcAddress(ntdll,"NtQueryVirtualMemory");
    UnixCall *entry=(UnixCall*)GetProcAddress(ntdll,"__wine_unix_call_dispatcher");
    if(!query||!entry)return FALSE;
    dispatcher=*entry;
    return query(GetCurrentProcess(),module,1000,&unixHandle,sizeof(unixHandle),NULL)==0;
}
__declspec(dllexport) LONG WINAPI mlXessBridge(unsigned command,MLXessCall *call){
    if(!call||call->size!=sizeof(*call)||call->version!=ML_XESS_VERSION)return (LONG)0xc000000d;
    return dispatcher(unixHandle,command,call);
}
