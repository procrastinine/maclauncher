#include <dlfcn.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>

__attribute__((constructor)) static void retireUnderLoaderLock(){
 if(!std::strcmp(std::getenv("WEBKIT_PROOF_MODE"),"exit")){
  std::puts("PASS original loader constructor reached process exit");std::fflush(stdout);
  std::exit(0);
 }
 auto retire=reinterpret_cast<void(*)(int)>(dlsym(RTLD_DEFAULT,"webkit_proof_retire"));
 if(!retire)std::abort();retire(0);
}
