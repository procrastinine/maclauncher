// SPDX-License-Identifier: MIT
// Fixed-width flat-C consumer. No Steam SDK declarations or implementation.
#include <array>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <dlfcn.h>
using u64=std::uint64_t;using u32=std::uint32_t;
static int checks=0;
#define CHECK(value,label) do{if(!(value))throw std::runtime_error(label);++checks;}while(0)
template<class F>static F load(void *library,const char *name){auto value=reinterpret_cast<F>(dlsym(library,name));if(!value)throw std::runtime_error(std::string("Missing symbol ")+name);return value;}
template<class T>static T read(const unsigned char *p){T value{};std::memcpy(&value,p,sizeof(value));return value;}
int main(int argc,char **argv){try{
 CHECK(argc==3,"Arguments");void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);CHECK(library,"Library load");
 const auto initialize=load<int(*)(const char *,char *)>(library,"SteamInternal_SteamAPI_Init");
 const auto shutdown=load<void(*)()>(library,"SteamAPI_Shutdown"),begin=load<void(*)()>(library,"SteamAPI_ManualDispatch_Init"),pump=load<void(*)()>(library,"SteamAPI_RunCallbacks");
 const auto next=load<bool(*)(int,void *)>(library,"SteamAPI_ManualDispatch_GetNextCallback");const auto release=load<void(*)(int)>(library,"SteamAPI_ManualDispatch_FreeLastCallback");
 const auto result=load<bool(*)(int,u64,void *,int,int,bool *)>(library,"SteamAPI_ManualDispatch_GetAPICallResult");
 const auto factory=load<void*(*)(const char *)>(library,"SteamInternal_CreateInterface");
 const auto statsGetter=load<void*(*)(void *,int,int,const char *)>(library,"SteamAPI_ISteamClient_GetISteamUserStats");
 const auto searchGetter=load<void*(*)(void *,int,int,const char *)>(library,"SteamAPI_ISteamClient_GetISteamGameSearch");
 const auto utilsGetter=load<void*(*)(void *,int,const char *)>(library,"SteamAPI_ISteamClient_GetISteamUtils");
 const auto store=load<bool(*)(void *)>(library,"SteamAPI_ISteamUserStats_StoreStats");
 const auto players=load<u64(*)(void *)>(library,"SteamAPI_ISteamUserStats_GetNumberOfCurrentPlayers");
 const auto board=load<u64(*)(void *,const char *,int,int)>(library,"SteamAPI_ISteamUserStats_FindOrCreateLeaderboard");
 const auto quota=load<bool(*)(void *,u64 *,u64 *)>(library,"SteamAPI_ISteamRemoteStorage_GetQuota");
 std::array<unsigned char,32>message;message.fill(0x7b);CHECK(!next(1,message.data()),"No callback before initialization");
 CHECK(message[0]==0x7b&&message[31]==0x7b,"Inactive callback output unchanged");
 setenv("SteamAppId","480",1);setenv("GseSavePath",argv[2],1);
 std::array<char,24>error;error.fill('q');CHECK(initialize(nullptr,error.data()+4)==0,"Flat initialization");
 CHECK(error[4]==0&&error[3]=='q'&&error[5]=='q'&&error[23]=='q',"Init error output clears exactly one byte");
 CHECK(std::string(load<const char*(*)()>(library,"MacLauncher_OfflineABI_Version")())=="maclauncher-offline-abi-0.5.0-universal","Exact helper version");
 void *client=factory("SteamClient021"),*stats=factory("STEAMUSERSTATS_INTERFACE_VERSION013"),*storage=factory("STEAMREMOTESTORAGE_INTERFACE_VERSION016");
 CHECK(client&&stats&&storage,"Measured flat interface versions");
 CHECK(statsGetter(client,1,1,"STEAMUSERSTATS_INTERFACE_VERSION013")==stats,"Flat getter returns exact family");
 CHECK(!statsGetter(client,0,1,"STEAMUSERSTATS_INTERFACE_VERSION013")&&!statsGetter(client,1,0,"STEAMUSERSTATS_INTERFACE_VERSION013"),"Flat getter rejects wrong handles");
 CHECK(!statsGetter(nullptr,1,1,"STEAMUSERSTATS_INTERFACE_VERSION013")&&!statsGetter(stats,1,1,"STEAMUSERSTATS_INTERFACE_VERSION013")&&!statsGetter(client,1,1,"SteamUser023"),"Flat getter rejects null and cross-family receiver/version");
 CHECK(searchGetter(client,1,1,"SteamMatchGameSearch001")&&factory("STEAMTIMELINE_INTERFACE_V004"),"Measured additional initializer families");
 CHECK(utilsGetter(client,1,"SteamUtils010")&&!utilsGetter(client,0,"SteamUtils010"),"Utility getter validates its measured pipe-only signature");
 CHECK(!factory("SteamClient022")&&!factory("STEAMTIMELINE_INTERFACE_V003")&&!dlsym(library,"SteamAPI_ISteamHTTP_CreateHTTPRequest"),"Unknown versions and unimplemented flat services remain unavailable");
 begin();begin();pump();CHECK(!next(0,message.data())&&!next(1,nullptr),"Manual dispatch validates pipe and output");
 CHECK(next(1,message.data()),"Manual initialization queues readiness once");
 CHECK(read<int>(message.data())==1&&read<int>(message.data()+4)==1101&&read<int>(message.data()+16)==20,"Callback message exact fields and 20-byte payload length");
 CHECK(message[20]==0x7b&&message[31]==0x7b,"Callback message writes only twenty bytes");
 auto *payload=read<const unsigned char *>(message.data()+8);CHECK(payload&&read<u64>(payload)==480&&read<int>(payload+8)==1&&read<u64>(payload+12)==76561197960265729ULL,"Readiness payload uses measured packed offsets");
 CHECK(!next(1,message.data()),"Payload remains held until release");release(0);CHECK(!next(1,message.data()),"Wrong-pipe release preserves held payload");release(1);CHECK(!next(1,message.data()),"Repeated manual initialization does not repeat readiness");
 CHECK(store(stats),"Local store queues event");CHECK(next(1,message.data()),"Stored event readable");payload=read<const unsigned char *>(message.data()+8);
 CHECK(read<int>(message.data()+4)==1102&&read<int>(message.data()+16)==12&&read<u64>(payload)==480&&read<int>(payload+8)==1,"Stored event twelve-byte payload");release(1);
 const u64 call=players(stats);CHECK(call!=0&&next(1,message.data()),"Local player-count call produces completion");payload=read<const unsigned char *>(message.data()+8);
 CHECK(read<int>(message.data()+4)==703&&read<int>(message.data()+16)==16&&read<u64>(payload)==call&&read<int>(payload+8)==1107&&read<u32>(payload+12)==8,"Completion payload exact sixteen-byte fields");
 release(1);std::array<unsigned char,24>output;output.fill(0x4a);struct Failure{unsigned char before=0x6a;bool value=false;unsigned char after=0x6b;}failed;
 CHECK(!result(0,call,output.data()+4,8,1107,&failed.value)&&failed.value&&failed.before==0x6a&&failed.after==0x6b,"Wrong-pipe result failure writes one bool byte");
 CHECK(!result(1,call,output.data()+4,7,1107,&failed.value)&&!result(1,call,output.data()+4,8,1104,&failed.value)&&!result(1,call,output.data()+4,8,1107,nullptr),"Mismatched size/type and null failure output preserve pending result");
 CHECK(output[4]==0x4a&&output[11]==0x4a,"Rejected result leaves payload output untouched");
 CHECK(result(1,call,output.data()+4,8,1107,&failed.value)&&!failed.value&&output[4]==0&&read<int>(output.data()+8)==0,"Offline player count stays explicitly unavailable");
 CHECK(output[3]==0x4a&&output[12]==0x4a&&output[23]==0x4a&&failed.before==0x6a&&failed.after==0x6b,"Result exact output widths preserve canaries");
 CHECK(!result(1,call,output.data()+4,8,1107,&failed.value),"Manual result consumed once");
 const u64 boardCall=board(stats,"manual-local-board",1,1);CHECK(boardCall&&next(1,message.data()),"Local board completion queued");payload=read<const unsigned char *>(message.data()+8);CHECK(read<u64>(payload)==boardCall&&read<int>(payload+8)==1104&&read<u32>(payload+12)==12,"Board completion reports its exact payload width");release(1);
 output.fill(0x4a);CHECK(result(1,boardCall,output.data()+4,12,1104,&failed.value)&&!failed.value&&read<u64>(output.data()+4)!=0&&output[12]==1&&output[3]==0x4a&&output[16]==0x4a,"Local board result and bounds");
 struct Quota{u64 before=123,total=456,middle=789,available=234,after=567;}space;
 CHECK(!quota(storage,&space.total,&space.available)&&space.total==0&&space.available==0&&space.before==123&&space.middle==789&&space.after==567,"Modern quota writes two eight-byte values only and remains unavailable");
 CHECK(!quota(storage,nullptr,nullptr),"Quota tolerates null outputs");
 std::array<u64,256>calls{};for(auto &pending:calls){pending=players(stats);CHECK(pending!=0,"Bounded manual result queue accepts capacity");}CHECK(players(stats)==0,"Manual event and pending-result queues share bounded capacity");
 for(auto pending:calls){CHECK(next(1,message.data()),"Queued completion drained");payload=read<const unsigned char *>(message.data()+8);CHECK(read<u64>(payload)==pending,"Completion order and call identity");release(1);}CHECK(!next(1,message.data())&&players(stats)==0,"Retained results remain included in queue capacity");
 CHECK(result(1,calls[0],output.data()+4,8,1107,&failed.value),"Retrieval releases one pending-result slot");CHECK(players(stats)!=0&&players(stats)==0,"Exactly one released slot becomes available");
 shutdown();message.fill(0x7b);CHECK(!next(1,message.data())&&!result(1,calls[1],output.data()+4,8,1107,&failed.value),"Shutdown clears pending and held results");
 CHECK(message[0]==0x7b&&message[31]==0x7b,"Shutdown dispatch preserves output");CHECK(initialize(nullptr,nullptr)==0,"Reinitialize with null error output");begin();CHECK(next(1,message.data())&&read<int>(message.data()+4)==1101,"New session has one independent readiness event");release(1);shutdown();dlclose(library);
 std::printf("PASS %d flat-C/manual dispatch bounds, failure and lifecycle checks\n",checks);return 0;
 }catch(const std::exception &error){std::fprintf(stderr,"FAIL after %d checks: %s\n",checks,error.what());return 1;}}
