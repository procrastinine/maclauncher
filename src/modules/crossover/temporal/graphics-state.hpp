#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
// The live Graphics state of a game, read by Windows adapters in its process.
// Each time MacLauncher publishes the game's effect plan (RESHADE_EFFECT_PLAN),
// it also writes effect-plan.active beside it: "1" while the plan makes the
// graphics library process the game's frames, "0" otherwise, as when Graphics
// is off. A background thread compares the file's write time and size every
// 100 ms and reads the byte only when they change, so active() never waits
// for file I/O. Without the variable, Wine's path conversion or the file, the
// state stays active, which is the adapters' behavior before this state.
#include <windows.h>
#include <atomic>
#include <cstring>
#include <string>
namespace maclauncher::graphics {
class LiveState {
public:
 // Starts the reader once; the first call answers active until its first read.
 static void start()noexcept{InitOnceExecuteOnce(&state().once,begin,nullptr,nullptr);}
 static bool active()noexcept{start();return state().value.load(std::memory_order_acquire);}
private:
 std::atomic<bool>value{true};
 INIT_ONCE once=INIT_ONCE_STATIC_INIT;
 std::wstring path;
 FILETIME written{};
 DWORD size=0;
 bool seen=false;
 static LiveState&state()noexcept{static LiveState value;return value;}
 static BOOL CALLBACK begin(PINIT_ONCE,PVOID,PVOID*){
  try{
   auto&self=state();
   wchar_t plan[32768];const DWORD length=GetEnvironmentVariableW(L"RESHADE_EFFECT_PLAN",plan,32768);if(!length||length>=32768)return TRUE;
   const int bytes=WideCharToMultiByte(CP_UTF8,0,plan,int(length),nullptr,0,nullptr,nullptr);if(bytes<=0)return TRUE;
   std::string unix(size_t(bytes),'\0');WideCharToMultiByte(CP_UTF8,0,plan,int(length),unix.data(),bytes,nullptr,nullptr);
   const auto slash=unix.find_last_of('/');if(slash==std::string::npos)return TRUE;
   unix.resize(slash+1);unix+="effect-plan.active";
   // Wine converts a Unix path for this prefix's drive mappings.
   const auto convert=reinterpret_cast<WCHAR*(CDECL*)(LPCSTR)>(GetProcAddress(GetModuleHandleW(L"kernel32.dll"),"wine_get_dos_file_name"));if(!convert)return TRUE;
   WCHAR*dos=convert(unix.c_str());if(!dos)return TRUE;self.path=dos;HeapFree(GetProcessHeap(),0,dos);
   // The reader thread runs this module's code until the process exits.
   HMODULE pinned=nullptr;if(!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS|GET_MODULE_HANDLE_EX_FLAG_PIN,reinterpret_cast<LPCWSTR>(&begin),&pinned))return TRUE;
   if(const HANDLE thread=CreateThread(nullptr,64*1024,poll,nullptr,STACK_SIZE_PARAM_IS_A_RESERVATION,nullptr))CloseHandle(thread);
  }catch(...){}
  return TRUE;
 }
 static DWORD WINAPI poll(LPVOID){for(;;){check();Sleep(100);}}
 static void check()noexcept{
  auto&self=state();WIN32_FILE_ATTRIBUTE_DATA data;
  if(!GetFileAttributesExW(self.path.c_str(),GetFileExInfoStandard,&data))return;
  if(self.seen&&!std::memcmp(&data.ftLastWriteTime,&self.written,sizeof(FILETIME))&&data.nFileSizeLow==self.size)return;
  const HANDLE file=CreateFileW(self.path.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,nullptr);
  if(file==INVALID_HANDLE_VALUE)return;
  char byte=0;DWORD read=0;const bool ok=ReadFile(file,&byte,1,&read,nullptr)&&read==1;CloseHandle(file);
  if(!ok||(byte!='0'&&byte!='1'))return;
  self.value.store(byte=='1',std::memory_order_release);self.written=data.ftLastWriteTime;self.size=data.nFileSizeLow;self.seen=true;
 }
};
}
