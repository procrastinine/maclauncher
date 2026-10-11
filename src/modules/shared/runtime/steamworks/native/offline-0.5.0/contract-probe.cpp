// SPDX-License-Identifier: MIT
// Fixed-width consumer fixtures; no Steam SDK headers or implementation.
#include <array>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <limits>
#include <cstdlib>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <dlfcn.h>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>
using u64=std::uint64_t; using u32=std::uint32_t;
struct Object { void **table; };
template<class F> F symbol(void *library,const char *name) {auto value=reinterpret_cast<F>(dlsym(library,name));if(!value)throw std::runtime_error(std::string("Missing symbol ")+name);return value;}
static int passed=0;
#define CHECK(value,label) do {if(!(value))throw std::runtime_error(label);++passed;} while(0)
static void (*unregisterCallback)(void *)=nullptr; static void (*shutdownAPI)()=nullptr;
struct Callback { void **table; unsigned char flags=0; unsigned char pad[3]{}; int type=0; int size=0; int calls=0; bool failed=false; u64 call=0; std::array<unsigned char,32> bytes{}; int action=0; void *other=nullptr; };
static void runSimple(Callback *self,void *data) {++self->calls;std::memcpy(self->bytes.data(),data,static_cast<std::size_t>(self->size));if(self->action==1)unregisterCallback(self->other);if(self->action==2)shutdownAPI();}
static void runResult(Callback *self,void *data,bool failed,u64 call) {self->failed=failed;self->call=call;runSimple(self,data);if(self->action==3)delete self;}
static int callbackSize(Callback *self) {return self->size;}
static void *callbackTable[]={reinterpret_cast<void *>(runSimple),reinterpret_cast<void *>(runResult),reinterpret_cast<void *>(callbackSize)};
static std::string hex(const std::string &name) {const char digits[]="0123456789abcdef";std::string value;for(unsigned char byte:name){value+=digits[byte>>4];value+=digits[byte&15];}return value;}
static std::string readBytes(const std::string &file) {FILE *stream=fopen(file.c_str(),"rb");if(!stream)return {};char bytes[256]{};const auto count=fread(bytes,1,sizeof(bytes),stream);fclose(stream);return std::string(bytes,count);}
static void writeBytes(const std::string &file,const char *bytes) {FILE *stream=fopen(file.c_str(),"wb");if(!stream)throw std::runtime_error("Fixture file cannot be written");fwrite(bytes,1,strlen(bytes),stream);fclose(stream);}
struct Context { void(*initialize)(void *); u64 generation=0; void *interface=nullptr; };
static void *(*findInterface)(int,const char *)=nullptr;static int contextCalls=0;
static void initContext(void *data) {++contextCalls;*static_cast<void **>(data)=findInterface(1,"SteamUtils010");}
int main(int argc,char **argv) {try {
 CHECK(argc>=3,"Arguments");void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);CHECK(library,"Library load");
 const auto init=symbol<bool(*)()>(library,"SteamAPI_Init");shutdownAPI=symbol<void(*)()>(library,"SteamAPI_Shutdown");
 const auto factory=symbol<void*(*)(const char*)>(library,"SteamInternal_CreateInterface");findInterface=symbol<void*(*)(int,const char*)>(library,"SteamInternal_FindOrCreateUserInterface");
 const auto registerCallback=symbol<void(*)(void*,int)>(library,"SteamAPI_RegisterCallback");unregisterCallback=symbol<void(*)(void*)>(library,"SteamAPI_UnregisterCallback");const auto pump=symbol<void(*)()>(library,"SteamAPI_RunCallbacks");
 const auto registerResult=symbol<void(*)(void*,u64)>(library,"SteamAPI_RegisterCallResult");const auto unregisterResult=symbol<void(*)(void*,u64)>(library,"SteamAPI_UnregisterCallResult");
 const auto contextInit=symbol<void*(*)(void*)>(library,"SteamInternal_ContextInit");
 const std::string root=argv[2];setenv("SteamAppId","480",1);unsetenv("GseSavePath");CHECK(!init(),"Missing root rejected");setenv("GseSavePath","relative",1);CHECK(!init(),"Relative root rejected");
 setenv("GseSavePath",root.c_str(),1);for(const char *id:{"0","-1","+480"," 480","480x","4294967296","99999999999999999999999"}){setenv("SteamAppId",id,1);CHECK(!init(),"Invalid app ID rejected");}setenv("SteamAppId","480",1);
 const std::string rootLink=root+"-symlink";CHECK(symlink(root.c_str(),rootLink.c_str())==0,"Create root link fixture");setenv("GseSavePath",rootLink.c_str(),1);CHECK(!init(),"Symlink root rejected");setenv("GseSavePath",root.c_str(),1);CHECK(init(),"Initialize owned root");
 CHECK(std::string(symbol<const char*(*)()>(library,"MacLauncher_OfflineABI_Version")())=="maclauncher-offline-abi-0.5.0-universal","Exact native version");
 CHECK(!factory("SteamClient999")&&!factory("SteamNetworkingSockets013")&&!factory(nullptr),"Unknown versions return null");CHECK(factory("STEAMUSERSTATS_INTERFACE_VERSION011")!=factory("STEAMUSERSTATS_INTERFACE_VERSION013"),"Stats versions have separate tables");
 auto *legacy=static_cast<Object*>(factory("STEAMUSERSTATS_INTERFACE_VERSION011")),*modern=static_cast<Object*>(factory("STEAMUSERSTATS_INTERFACE_VERSION013")),*storage=static_cast<Object*>(factory("STEAMREMOTESTORAGE_INTERFACE_VERSION013"));CHECK(legacy&&modern&&storage,"Known factory pointers");
 if(argc>3&&std::string(argv[3])=="unsupported") {auto *client=static_cast<Object*>(factory("SteamClient017"));reinterpret_cast<void(*)(Object*)>(client->table[70])(client);throw std::runtime_error("Unknown method returned");}
 const auto request=reinterpret_cast<bool(*)(Object*)>(legacy->table[0]);const auto getAchievement=reinterpret_cast<bool(*)(Object*,const char*,bool*)>(legacy->table[6]);const auto setAchievement=reinterpret_cast<bool(*)(Object*,const char*)>(legacy->table[7]);const auto clearAchievement=reinterpret_cast<bool(*)(Object*,const char*)>(legacy->table[8]);
 const auto fileWrite=reinterpret_cast<bool(*)(Object*,const char*,const void*,int)>(storage->table[0]);const auto fileRead=reinterpret_cast<int(*)(Object*,const char*,void*,int)>(storage->table[1]);
 bool value=true;CHECK(!getAchievement(legacy,"fixture-achievement",&value)&&!value,"Missing achievement is unavailable");CHECK(setAchievement(legacy,"fixture-achievement"),"Achievement write");CHECK(getAchievement(legacy,"fixture-achievement",&value)&&value,"Achievement roundtrip");CHECK(clearAchievement(legacy,"fixture-achievement"),"Achievement clear");CHECK(getAchievement(legacy,"fixture-achievement",&value)&&!value,"Cleared achievement false");

 auto *client=static_cast<Object*>(factory("SteamClient017"));
 struct Provider {int slot;const char *version;};
 const Provider providers[]={
  {5,"SteamUser018"},{8,"SteamFriends015"},{9,"SteamUtils007"},{10,"SteamMatchMaking009"},{11,"SteamMatchMakingServers002"},
  {13,"STEAMUSERSTATS_INTERFACE_VERSION011"},{15,"STEAMAPPS_INTERFACE_VERSION007"},{16,"SteamNetworking005"},{17,"STEAMREMOTESTORAGE_INTERFACE_VERSION013"},{18,"STEAMSCREENSHOTS_INTERFACE_VERSION002"},
  {23,"STEAMHTTP_INTERFACE_VERSION002"},{24,"STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001"},{25,"SteamController003"},{26,"STEAMUGC_INTERFACE_VERSION007"},{27,"STEAMAPPLIST_INTERFACE_VERSION001"},
  {28,"STEAMMUSIC_INTERFACE_VERSION001"},{29,"STEAMMUSICREMOTE_INTERFACE_VERSION001"},{30,"STEAMHTMLSURFACE_INTERFACE_VERSION_003"},{34,"STEAMINVENTORY_INTERFACE_V001"},{35,"STEAMVIDEO_INTERFACE_V001"}
 };
 for(const auto &provider:providers) {void *object=nullptr; if(provider.slot==9) {const auto getter=reinterpret_cast<void*(*)(Object*,int,const char*)>(client->table[provider.slot]);object=getter(client,1,provider.version);CHECK(!getter(client,0,provider.version)&&!getter(client,1,"SteamUser018"),"Utility getter validates handle and family");}else{const auto getter=reinterpret_cast<void*(*)(Object*,int,int,const char*)>(client->table[provider.slot]);object=getter(client,1,1,provider.version);CHECK(!getter(client,0,1,provider.version)&&!getter(client,1,0,provider.version),"Provider getter validates both handles");if(provider.slot!=5)CHECK(!getter(client,1,1,"SteamUser018"),"Provider rejects mismatched family");}CHECK(object&&object==factory(provider.version),"All twenty original context providers are non-null exact families");}
 CHECK(!findInterface(0,"SteamUser018")&&!findInterface(2,"SteamUser018")&&!findInterface(2,"SteamUtils010")&&findInterface(0,"SteamUtils010")==factory("SteamUtils010"),"Global getter accepts the measured zero-handle utility contract only");
 CHECK(factory("SteamClient017")!=factory("SteamClient023")&&factory("SteamUser018")!=factory("SteamUser023")&&factory("SteamFriends015")!=factory("SteamFriends018"),"Observed version layouts retain separate primary tables");
 auto *screens=static_cast<Object*>(factory("STEAMSCREENSHOTS_INTERFACE_VERSION002")),*ugc=static_cast<Object*>(factory("STEAMUGC_INTERFACE_VERSION007"));reinterpret_cast<void(*)(Object*,bool)>(screens->table[3])(screens,true);reinterpret_cast<void(*)(Object*,bool)>(screens->table[3])(screens,false);CHECK(true,"Legacy screenshot hook accepts both lifecycle values");
 std::array<u64,2> subscriptions{{123,456}};CHECK(reinterpret_cast<u32(*)(Object*)>(ugc->table[50])(ugc)==0&&reinterpret_cast<u32(*)(Object*,u64*,u32)>(ugc->table[51])(ugc,subscriptions.data(),2)==0&&subscriptions[0]==123&&subscriptions[1]==456,"Offline workshop enumeration returns empty without writing outside returned count");
 struct Quota {u32 before=0x12345678,total=99,middle=0x23456789,available=98,after=0x3456789a;}quota;
 CHECK(!reinterpret_cast<bool(*)(Object*,u32*,u32*)>(storage->table[20])(storage,&quota.total,&quota.available)&&quota.total==0&&quota.available==0&&quota.before==0x12345678&&quota.middle==0x23456789&&quota.after==0x3456789a,"Legacy quota writes only each measured four-byte output");
 CHECK(!reinterpret_cast<bool(*)(Object*)>(storage->table[21])(storage)&&!reinterpret_cast<bool(*)(Object*)>(storage->table[22])(storage),"Cloud status stays disconnected");
 const auto getInt=reinterpret_cast<bool(*)(Object*,const char*,std::int32_t*)>(legacy->table[1]);const auto setInt=reinterpret_cast<bool(*)(Object*,const char*,std::int32_t)>(legacy->table[3]);
 const auto getFloat=reinterpret_cast<bool(*)(Object*,const char*,float*)>(legacy->table[2]);const auto setFloat=reinterpret_cast<bool(*)(Object*,const char*,float)>(legacy->table[4]);
 std::int32_t integer=77;float real=77;CHECK(!getInt(legacy,"integer",&integer)&&integer==0&&!getFloat(legacy,"real",&real)&&real==0,"Absent statistics are unavailable with initialized outputs");
 CHECK(setInt(legacy,"integer",-12345)&&getInt(legacy,"integer",&integer)&&integer==-12345&&setFloat(legacy,"real",1.25f)&&getFloat(legacy,"real",&real)&&real==1.25f,"Local typed statistics roundtrip");
 CHECK(!setFloat(legacy,"real",std::numeric_limits<float>::infinity())&&!setFloat(legacy,"real",std::numeric_limits<float>::quiet_NaN())&&!getInt(legacy,"integer",nullptr)&&!getFloat(legacy,"real",nullptr),"Typed statistics reject invalid pointers and nonfinite values");
 const auto reset=reinterpret_cast<bool(*)(Object*,bool)>(legacy->table[21]);CHECK(setAchievement(legacy,"reset-achievement")&&reset(legacy,false)&&!getInt(legacy,"integer",&integer)&&!getFloat(legacy,"real",&real)&&getAchievement(legacy,"reset-achievement",&value)&&value,"Statistic reset preserves achievements when disabled");
 CHECK(setInt(legacy,"integer",7)&&reset(legacy,true)&&!getInt(legacy,"integer",&integer)&&!getAchievement(legacy,"reset-achievement",&value),"Repeated reset removes only owned statistic and selected achievement records");
 auto *newUser=static_cast<Object*>(factory("SteamUser023")),*newFriends=static_cast<Object*>(factory("SteamFriends018"));const auto ownId=reinterpret_cast<u64(*)(Object*)>(newUser->table[2])(newUser);
 CHECK(reinterpret_cast<int(*)(Object*)>(newUser->table[24])(newUser)==0&&!reinterpret_cast<bool(*)(Object*,u64,bool)>(newFriends->table[36])(newFriends,ownId,true)&&std::string(reinterpret_cast<const char*(*)(Object*,u64)>(newFriends->table[6])(newFriends,ownId))=="Player"&&std::string(reinterpret_cast<const char*(*)(Object*,u64)>(newFriends->table[6])(newFriends,ownId+1)).empty(),"Measured modern identity queries expose only a local persona");
 
 const std::string oversizedName(121,'x');CHECK(!setAchievement(legacy,oversizedName.c_str())&&!setAchievement(legacy,"")&&!getAchievement(legacy,nullptr,&value)&&!getAchievement(legacy,"fixture-achievement",nullptr),"Invalid achievement parameters");
 const std::string state=root+"/maclauncher-offline-api-v1/480",outside=root+"/outside-file";writeBytes(outside,"untouched");writeBytes(state+"/achievement-"+hex("corrupt"),"\1\1");CHECK(!getAchievement(legacy,"corrupt",&value)&&!value,"Oversized achievement record is unavailable");
 const std::array<unsigned char,6> payload{{0,1,2,0,255,64}};CHECK(fileWrite(storage,"../opaque-name",payload.data(),6),"Remote byte write");CHECK(reinterpret_cast<bool(*)(Object*,const char*)>(storage->table[13])(storage,"../opaque-name")&&reinterpret_cast<int(*)(Object*,const char*)>(storage->table[15])(storage,"../opaque-name")==6,"Measured remote existence and size");CHECK(fileWrite(storage,"delete-me",payload.data(),6)&&reinterpret_cast<bool(*)(Object*,const char*)>(storage->table[6])(storage,"delete-me")&&!reinterpret_cast<bool(*)(Object*,const char*)>(storage->table[13])(storage,"delete-me"),"Measured remote deletion is confined to the named record");std::array<unsigned char,8> output{};output.fill(77);CHECK(fileRead(storage,"../opaque-name",output.data(),4)==4&&!memcmp(output.data(),payload.data(),4)&&output[4]==77,"Remote partial read bounds");CHECK(fileRead(storage,"../opaque-name",output.data(),8)==6&&!memcmp(output.data(),payload.data(),6),"Remote binary roundtrip");
 CHECK(!fileWrite(storage,"bad",nullptr,1)&&!fileWrite(storage,"bad",payload.data(),-1)&&!fileWrite(storage,"bad",payload.data(),16777217)&&!fileWrite(storage,oversizedName.c_str(),payload.data(),1)&&fileRead(storage,"../opaque-name",nullptr,8)==0,"Remote invalid parameters");
 const std::string link=state+"/remote-"+hex("linked");CHECK(symlink(outside.c_str(),link.c_str())==0,"Create record symlink");CHECK(fileRead(storage,"linked",output.data(),8)==0,"Symlink read rejected");CHECK(fileWrite(storage,"linked",payload.data(),6)&&readBytes(outside)=="untouched","Atomic record replace preserves external file");
 Callback stats{callbackTable};stats.size=20;registerCallback(&stats,1101);registerCallback(&stats,1101);CHECK((stats.flags&1)&&stats.type==1101&&request(legacy),"Callback registration fields");pump();CHECK(stats.calls==1,"Duplicate callback registration dispatches once");u64 game=0;int result=0;memcpy(&game,stats.bytes.data(),8);memcpy(&result,stats.bytes.data()+8,4);CHECK(game==480&&result==1,"Legacy typed callback contents");
 CHECK(request(legacy),"Queue before unregister");unregisterCallback(&stats);pump();CHECK(stats.calls==1&&!(stats.flags&1),"Unregister cancels queued recipient");
 Callback wrong{callbackTable};wrong.size=12;registerCallback(&wrong,1101);CHECK(request(legacy),"Queue incompatible callback");pump();CHECK(wrong.calls==0,"Incompatible callback size skipped");unregisterCallback(&wrong);
 Callback first{callbackTable},second{callbackTable};first.size=second.size=20;first.action=1;first.other=&second;registerCallback(&first,1101);registerCallback(&second,1101);CHECK(request(legacy),"Queue cross-unregister event");pump();CHECK(first.calls==1&&second.calls==0,"Callback can unregister another recipient");unregisterCallback(&first);
 for(int i=0;i<256;++i)CHECK(request(legacy),"Bounded queue accepted");CHECK(!request(legacy),"Queue capacity returns failure");pump();
 const auto leaderboard=reinterpret_cast<u64(*)(Object*,const char*,int,int)>(modern->table[21]);const auto players=reinterpret_cast<u64(*)(Object*)>(modern->table[32]);
 Callback call{callbackTable};call.type=1104;call.size=12;const u64 handle=leaderboard(modern,"fixture-board",1,1);CHECK(handle,"Leaderboard call handle");registerResult(&call,handle);registerResult(&call,handle);pump();CHECK(call.calls==1&&call.call==handle&&!call.failed,"Typed call-result callback delivered once");u64 board=0;int found=0;memcpy(&board,call.bytes.data(),8);memcpy(&found,call.bytes.data()+8,4);CHECK(board&&found==1,"Offline leaderboard created locally");pump();CHECK(call.calls==1,"Call-result not repeated");
 const u64 cancelled=leaderboard(modern,"fixture-cancelled",1,1);registerResult(&call,cancelled);unregisterResult(&call,cancelled);pump();CHECK(call.calls==1,"Unregister cancels call-result");
 Callback badCall{callbackTable};badCall.type=1104;badCall.size=8;const u64 badHandle=leaderboard(modern,"fixture-size",1,1);registerResult(&badCall,badHandle);pump();CHECK(!badCall.calls,"Wrong call-result payload size skipped");
 Callback number{callbackTable};number.type=1107;number.size=8;const auto numberCall=players(modern);registerResult(&number,numberCall);pump();CHECK(number.calls==1&&!number.failed&&number.bytes[0]==0,"Offline player count is unavailable");int count=-1;memcpy(&count,number.bytes.data()+4,4);CHECK(count==0,"Offline player count is not invented");
 auto *selfDestruct=new Callback{callbackTable};selfDestruct->type=1104;selfDestruct->size=12;selfDestruct->action=3;const auto selfCall=leaderboard(modern,"fixture-destroy",1,1);registerResult(selfDestruct,selfCall);pump();CHECK(true,"Call-result listener may destroy itself");
 CHECK(!leaderboard(modern,"",1,1)&&!leaderboard(modern,"fixture-invalid",0,1)&&!leaderboard(modern,"fixture-invalid",1,4),"Invalid leaderboard parameters fail");
 Context context{initContext};CHECK(contextInit(&context)==&context.interface&&context.interface&&contextCalls==1,"Context initializer layout");CHECK(contextInit(&context)==&context.interface&&contextCalls==1,"Context cached for generation");
 Callback closing{callbackTable},after{callbackTable};closing.size=after.size=20;closing.action=2;registerCallback(&closing,1101);registerCallback(&after,1101);CHECK(request(legacy),"Queue shutdown recipient");pump();CHECK(closing.calls==1&&!after.calls&&!closing.flags&&!after.flags,"Shutdown prevents later callback access");CHECK(!factory("SteamClient017")&&!request(legacy),"Shutdown clears interface availability");
 CHECK(init(),"Reinitialize");CHECK(contextInit(&context)==&context.interface&&contextCalls==2,"Context refreshes after shutdown");CHECK(fileRead(storage,"../opaque-name",output.data(),8)==6,"Remote data persists across restart");shutdownAPI();dlclose(library);std::printf("PASS %d fixed-width callback, storage, failure and lifecycle checks\n",passed);return 0;
 }catch(const std::exception &failure){std::fprintf(stderr,"FAIL after %d checks: %s\n",passed,failure.what());return 1;}}
