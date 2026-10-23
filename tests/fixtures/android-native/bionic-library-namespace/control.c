#define _GNU_SOURCE
#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
extern uint64_t klj_bionic_application_libraries(uint64_t);
int main(int argc,char **argv){
 if(argc==3&&!strcmp(argv[1],"--denied")){
  struct stat st;assert(stat(argv[2],&st)==-1&&errno==EACCES);
  assert(!klj_bionic_application_libraries((uintptr_t)argv[2]));
  char denied[4096];assert(snprintf(denied,sizeof denied,"%s/libnamespace-parent.so",argv[2])>0);
  assert(!dlopen(denied,RTLD_NOW|RTLD_LOCAL));
  puts("PASS uninitialized host-private installed-code parents deny app traversal");return 0;
 }
 assert(argc==2||argc==4);
 const char *directory=argv[1];char absolute[4096];
 assert(snprintf(absolute,sizeof absolute,"%s/libnamespace-parent.so",directory)>0);
 void *parent=dlopen(absolute,RTLD_NOW|RTLD_LOCAL);if(!parent)fprintf(stderr,"parent: %s\n",dlerror());assert(parent);
 void *(*open_companion)(const char*)=dlsym(parent,"open_companion");assert(open_companion);
 assert(!open_companion("libnamespace-companion.so"));
 assert((int64_t)klj_bionic_application_libraries(0)==-EINVAL);
 assert((int64_t)klj_bionic_application_libraries((uintptr_t)"relative")==-EINVAL);
 assert((int64_t)klj_bionic_application_libraries((uintptr_t)"/current:/peer")==-EINVAL);
 assert(!klj_bionic_application_libraries((uintptr_t)"/nonexistent/namespace-directory"));
 assert(!open_companion("libnamespace-companion.so"));
 errno=219;assert(!klj_bionic_application_libraries((uintptr_t)directory)&&errno==219);
 void *companion=open_companion("libnamespace-companion.so");if(!companion)fprintf(stderr,"companion: %s\n",dlerror());assert(companion);
 int(*value)(void)=dlsym(companion,"namespace_value");assert(value&&value()==42);
 Dl_info info={0};assert(dladdr((const void*)value,&info)&&info.dli_fname&&strstr(info.dli_fname,directory)==info.dli_fname);
 assert(!open_companion("libnamespace-peer.so"));
 void *platform=open_companion("libm.so");assert(platform&&dlsym(platform,"sin"));assert(!dlclose(platform));
 if(argc==4){void *original=open_companion(argv[2]);if(!original)fprintf(stderr,"original library: %s\n",dlerror());assert(original&&dlsym(original,argv[3]));assert(!dlclose(original));puts("PASS original APK companion loads through original caller namespace");}
 assert(!dlclose(companion)&&!dlclose(parent));
 puts("PASS original Bionic caller namespace sibling dependency and peer exclusion");return 0;
}
