#include "resolver-guest.h"
#include <binder/IPermissionController.h>
#include <binder/IServiceManager.h>
#include <binder/ProcessState.h>
#include <android/binder_manager.h>
#include <aidl/android/net/IDnsResolver.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#undef NDEBUG
#include <cassert>
#include <cstdio>
#include <cstring>
#include <cstdlib>
using namespace android;
// Test-only permission owner. Production resolves the authenticated profile's
// original IPermissionController, already covered by its own transport check.
class Permissions final:public BnPermissionController {
 bool checkPermission(const String16&,int32_t,int32_t uid)override{return uid==1000;}
 int32_t noteOp(const String16&,int32_t,const String16&)override{return 2;}
 void getPackagesForUid(uid_t,Vector<String16>&)override{}
 bool isRuntimePermission(const String16&)override{return false;}
 int getPackageUid(const String16&,int)override{return -1;}
};
int main(int argc,char**argv){
 assert(argc==2);
 if(strcmp(argv[1],"serve")==0)assert(klj_art_resolver_prepare());
 ProcessState::self()->startThreadPool();
 if(strcmp(argv[1],"serve")==0){
  assert(getuid()==1000);
  assert(defaultServiceManager()->addService(String16("permission"),sp<Permissions>::make())==OK);
  assert(klj_art_resolver_start(true,false));
  assert(klj_art_resolver_network(41,1|8)==0);
  int socket=::socket(AF_INET,SOCK_DGRAM|SOCK_CLOEXEC,IPPROTO_UDP);assert(socket>=0);
  errno=0;int ownership=fchown(socket,10001,static_cast<gid_t>(-1));
  fprintf(stderr,"Original resolver route-probe socket ownership: uid=%u fchown=%d errno=%d\n",getuid(),ownership,errno);close(socket);
  puts("READY original resolver");fflush(stdout);char command;assert(read(0,&command,1)==1);
  assert(klj_art_resolver_network(0,0)==0);puts("PASS original resolver cache retirement");return 0;
 }
 assert(strcmp(argv[1],"client")==0&&getuid()==10001);
 auto resolver=aidl::android::net::IDnsResolver::fromBinder(ndk::SpAIBinder(AServiceManager_checkService("dnsresolver")));assert(resolver);
 assert(!resolver->destroyNetworkCache(41).isOk());
 addrinfo hints{};hints.ai_family=AF_INET;hints.ai_socktype=SOCK_STREAM;addrinfo*addresses=nullptr;
 int status=getaddrinfo("localhost",nullptr,&hints,&addresses);
 if(status){fprintf(stderr,"localhost: %s errno %d\n",gai_strerror(status),errno);return 3;}
 assert(addresses);freeaddrinfo(addresses);addresses=nullptr;
 status=getaddrinfo("doubleclick.net",nullptr,&hints,&addresses);
 // Bionic's original proxy maps resolver failures to EAI_NODATA.
 if(status!=EAI_NODATA){fprintf(stderr,"advertising policy: %d errno %d\n",status,errno);return 4;}
 assert(!addresses);
 if(const char*name=getenv("ART_DNS_PROBE_NAME")){
  for(const auto flags:{0,AI_CANONNAME,AI_ADDRCONFIG,AI_CANONNAME|AI_ADDRCONFIG}){
   hints.ai_family=AF_UNSPEC;hints.ai_flags=flags;
   status=getaddrinfo(name,nullptr,&hints,&addresses);
   if(status){fprintf(stderr,"configured DNS flags=%d: %s errno %d\n",flags,gai_strerror(status),errno);return 5;}
   assert(addresses);unsigned count=0;for(auto*entry=addresses;entry;entry=entry->ai_next)count++;
   fprintf(stderr,"Original Bionic DNS flags=%d addresses=%u\n",flags,count);
   freeaddrinfo(addresses);addresses=nullptr;
  }
  puts("PASS original resolver query through configured Mac DNS");
 }
 puts("PASS original Bionic DNS socket, nonroot configuration denial and shared advertising policy");return 0;
}
