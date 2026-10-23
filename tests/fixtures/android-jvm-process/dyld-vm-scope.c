#include <dlfcn.h>
#include <stdio.h>
int main(int argc,char **argv){
 if(argc!=3)return 2;void *caller=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL),*vm=dlopen(argv[2],RTLD_NOW|RTLD_LOCAL);if(!caller||!vm){fprintf(stderr,"%s\n",dlerror());return 3;}
 void *(*self)(const char*)=dlsym(caller,"vm_self"),*(*next)(const char*)=dlsym(caller,"vm_next");void *(*direct)(void)=dlsym(caller,"vm_direct");if(!self||!next||!direct)return 4;
 void *explicit=dlsym(vm,"JNI_CreateJavaVM"),*ordinary=dlsym(vm,"JNI_GetCreatedJavaVMs");Dl_info owner={0};if(explicit)dladdr(explicit,&owner);
 printf("{\"selfSame\":%d,\"nextSame\":%d,\"directSame\":%d,\"otherApiSelf\":%d,\"otherApiNext\":%d,\"owner\":\"%s\"}\n",self("JNI_CreateJavaVM")==explicit,next("JNI_CreateJavaVM")==explicit,direct()==explicit,self("JNI_GetCreatedJavaVMs")==ordinary,next("JNI_GetCreatedJavaVMs")==ordinary,owner.dli_fname?owner.dli_fname:"");return 0;
}
