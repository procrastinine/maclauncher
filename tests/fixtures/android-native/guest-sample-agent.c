/* Test-only entry into Klepton's supplied image map and native sampler. */
#include <jni.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
static void *sample(void *argument){
 char *path=argument;void *library=NULL;void *(*find)(const char*)=NULL;
 for(unsigned attempt=0;attempt<150;attempt++){
  if(!library)library=dlopen(path,RTLD_NOLOAD|RTLD_LAZY);
  if(library&&!find)find=dlsym(library,"kl_find_image");
  if(find&&find("libunity.so"))break;
  usleep(100000);
 }
 free(path);
 if(!library||!find||!find("libunity.so")){fprintf(stderr,"[guest-sample] Unity image did not load\n");if(library)dlclose(library);return NULL;}
 sleep(2);
 void (*images)(FILE*)=dlsym(library,"kl_dl_report_images");
 int (*start)(unsigned,const char*)=dlsym(library,"kl_sample_start");
 void (*stop)(FILE*)=dlsym(library,"kl_sample_stop_report");
 if(!images||!start||!stop){fprintf(stderr,"[guest-sample] Supplied diagnostics unavailable\n");dlclose(library);return NULL;}
 images(stderr);if(start(10,NULL)){sleep(10);stop(stderr);}dlclose(library);return NULL;
}
JNIEXPORT jint JNICALL Agent_OnLoad(JavaVM *vm,char *options,void *reserved){
 (void)vm;(void)reserved;if(!options||!*options)return JNI_ERR;
 char *path=strdup(options);if(!path)return JNI_ERR;
 setenv("KL_SAMPLE_STACKS","1",1);setenv("KL_SAMPLE_REPORT_S","5",1);
 pthread_t thread;if(pthread_create(&thread,NULL,sample,path)){free(path);return JNI_ERR;}pthread_detach(thread);return JNI_OK;
}
