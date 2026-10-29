#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>
#include <limits.h>
static void *(*lookup)(const char *);
static int (*java_tid)(void *,void *),(*thread_id)(void);
static int check(void){
 int (*gettid)(void)=lookup("gettid");
 long (*syscall)(long,long,long,long,long,long,long)=lookup("syscall");
 assert(gettid&&syscall);int id=gettid();assert(id>0&&id<(1<<22));
 assert(id==java_tid(NULL,NULL));assert(id==thread_id());assert(id==syscall(178,0,0,0,0,0,0));
 return id;
}
static void *worker(void *parent){assert(check()!=*(int*)parent);return NULL;}
int main(int argc,char **argv){
 assert(argc==3);char path[PATH_MAX];
 snprintf(path,sizeof(path),"%s/native/libklepton-jvm.dylib",argv[1]);void *core=dlopen(path,RTLD_LAZY|RTLD_GLOBAL);if(!core){fprintf(stderr,"%s\n",dlerror());return 1;}
 snprintf(path,sizeof(path),"%s/native/libnativebinding.dylib",argv[1]);void *binding=dlopen(path,RTLD_LAZY|RTLD_GLOBAL);if(!binding){fprintf(stderr,"%s\n",dlerror());return 1;}
 int (*configure)(const char *)=dlsym(core,"klj_process_ids_configure");assert(configure&&configure(argv[2])>0);
 lookup=dlsym(core,"kl_shim_lookup");java_tid=dlsym(binding,"Java_libcore_io_Linux_nativeGettid");thread_id=dlsym(core,"klj_thread_id");
 assert(lookup&&java_tid&&thread_id);int parent=check();assert(parent>0);
 pthread_t thread;assert(!pthread_create(&thread,NULL,worker,&parent));assert(!pthread_join(thread,NULL));
 puts("PASS built runtime original Java, thread owner, guest libc and raw syscall share thread identities");
}
