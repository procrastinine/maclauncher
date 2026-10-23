#include <dlfcn.h>
#include <dirent.h>
#include <unistd.h>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static int descriptors(){int count=0;DIR*directory=opendir("/proc/self/fd");if(!directory)std::abort();while(auto entry=readdir(directory))if(entry->d_name[0]!='.')++count;closedir(directory);return count;}
int main(int argc,char**argv){
 if(argc!=5)return 2;
 void*client=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);if(!client){std::fprintf(stderr,"%s\n",dlerror());return 3;}
 auto open=reinterpret_cast<void(*)(const char*)>(dlsym(client,"webkit_proof_open"));
 auto retire=reinterpret_cast<void(*)(int)>(dlsym(client,"webkit_proof_retire"));
 auto released=reinterpret_cast<int(*)()>(dlsym(client,"webkit_proof_released"));
 if(!open||!retire||!released){std::fprintf(stderr,"%s\n",dlerror());return 4;}
 const int baseline=descriptors();open(argv[3]);
 if(!std::strcmp(argv[4],"explicit"))retire(1);
 else{
  // NODELETE retains the actual native worker and its unwind metadata even
  // when the caller releases the DSO handle before retirement completes.
  if(dlclose(client))return 5;
  client=dlopen(argv[1],RTLD_NOW|RTLD_NOLOAD);if(!client)return 6;dlclose(client);
  setenv("WEBKIT_PROOF_MODE",argv[4],1);
  void*constructor=dlopen(argv[2],RTLD_NOW);if(!constructor){std::fprintf(stderr,"%s\n",dlerror());return 7;}dlclose(constructor);
 }
 const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(3);
 while((!released()||descriptors()!=baseline)&&std::chrono::steady_clock::now()<until)usleep(1000);
 if(!released()||descriptors()!=baseline)return 8;
 std::printf("PASS original Bionic WebKit %s: callback owner, worker state and descriptors retired\n",argv[4]);
 return 0;
}
