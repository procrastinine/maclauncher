#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void *(*original_lookup)(const char *);
static const char *(*original_guest_path)(const char *,char *,size_t);
const char *kl_guest_path(const char *name,char *buffer,size_t capacity){return original_guest_path(name,buffer,capacity);}
static int (*original_errno_from_linux)(int), (*original_errno_to_linux)(int);
int kl_errno_from_linux(int error) { return original_errno_from_linux(error); }
static void *kl_upstream_shim_lookup(const char *name){return original_lookup(name);}
#include "native-file-imports.h"
void *kl_shim_lookup(const char *name){void *value=klj_native_file_lookup(name);return value?value:original_lookup(name);}
#include ANDROID_SYSCALL_SOURCE

// Execute the unchanged native property reader and current enumeration against
// a deterministic Build source; DNS still uses its actual native provider.
static int kl_jni_build_int(const char *name,int fallback){(void)name;return fallback;}
static const char *kl_jni_build_string(const char *name){return name;}
const char *kl_driver_target_name(void){return "hl2";}
static int kl_env_on(const char *name,int fallback){(void)name;return fallback;}
#include ANDROID_PROPERTY_SOURCE
static void *property_lookup(const char *name){
    if(!strcmp(name,"__system_property_get"))return klb_sysprop_get;
    if(!strcmp(name,"__system_property_find"))return klb_sysprop_find;
    if(!strcmp(name,"__system_property_read"))return klb_sysprop_read;
    return NULL;
}
#define kl_upstream_shim_lookup property_lookup
#include "android-properties.h"
#undef kl_upstream_shim_lookup

struct properties {const void *handles[128];size_t count;};
static void snapshot(void *cookie,const char *name,const char *value,uint32_t serial){
    const void *handle=cookie;char actual[92];
    assert(klj_android_property_find(name)==handle);
    assert(klj_android_property_get(name,actual)==(int)strlen(value)&&!strcmp(actual,value));
    assert(serial==klj_android_property_serial(handle));
}
static void visit(const void *handle,void *cookie){
    struct properties *properties=cookie;assert(properties->count<128);
    for(size_t i=0;i<properties->count;i++)assert(strcmp(klj_android_property_name(handle),klj_android_property_name(properties->handles[i])));
    properties->handles[properties->count++]=handle;
    klj_android_property_read_callback(handle,snapshot,(void *)handle);
}
int main(int argc,char **argv){
    assert(argc==2);void *runtime=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!runtime){puts(dlerror());return 1;}
    original_lookup=dlsym(runtime,"kl_shim_lookup");assert(original_lookup);
    original_guest_path=dlsym(runtime,"kl_guest_path");assert(original_guest_path);
    original_errno_from_linux=dlsym(runtime,"kl_errno_from_linux");original_errno_to_linux=dlsym(runtime,"kl_errno_to_linux");
    assert(original_errno_from_linux&&original_errno_to_linux);
    struct properties properties={0};assert(!klj_android_property_foreach(visit,&properties));
    assert(properties.count>sizeof klj_android_properties/sizeof *klj_android_properties);
    for(size_t i=0;i<properties.count;i++)assert(klj_android_property_find_nth((unsigned)i)==properties.handles[i]);
    assert(!klj_android_property_find_nth((unsigned)properties.count));
    const char *long_name="debug.hl2q3vr.internal_multiview_probe";
    const void *long_handle=klj_android_property_find(long_name);assert(long_handle&&strlen(long_name)>32);
    assert(!strcmp(klj_android_property_name(long_handle),long_name));
    assert(klj_android_property_foreach(NULL,NULL)==-1&&errno==EINVAL);
    assert(klj_android_property_find("not.an.android.property")==NULL);
    char directory[]="/private/tmp/android-native-capabilities-XXXXXX";assert(mkdtemp(directory));
    int cwd=open(".",O_RDONLY),dir=open(directory,O_RDONLY);assert(cwd>=0&&dir>=0&&fchdir(dir)==0);
    int fd=(int)klb_syscall(56,-100,(long)"entry",0x40|0x80|2,0600,0,0);assert(fd>=0);
    assert(klb_syscall(64,fd,(long)"payload",7,0,0,0)==7);
    assert(klb_syscall(62,fd,0,SEEK_SET,0,0,0)==0);
    char data[16]={0};assert(klb_syscall(63,fd,(long)data,7,0,0,0)==7&&!strcmp(data,"payload"));
    assert(klb_syscall(46,fd,4,0,0,0,0)==0&&klb_syscall(82,fd,0,0,0,0,0)==0);
    int other=klj_openat_2(dir,"entry",0);assert(other>=0);
    memset(data,0,sizeof data);assert(read(other,data,sizeof data)==4&&!strcmp(data,"payl"));close(other);
    other=klj_open_2("entry",0);assert(other>=0);close(other);
    assert(!klb_syscall(57,fd,0,0,0,0,0));
    assert(klj_openat_2(-100,"absent",0)==-1&&errno==ENOENT);
    for(int variant=0;variant<3;variant++){
        pid_t child=fork();assert(child>=0);if(!child){struct rlimit limit={0,0};setrlimit(RLIMIT_CORE,&limit);
            if(!variant)klj_open_2("must-not-exist",0x40);
            else klj_openat_2(dir,"must-not-exist",variant==1?0x40:0x404000);
            _exit(77);
        }
        int status;assert(waitpid(child,&status,0)==child&&WIFSIGNALED(status)&&WTERMSIG(status)==SIGABRT);
    }
    assert(access("must-not-exist",F_OK)==-1&&errno==ENOENT);
    struct timespec now={0};assert(!klb_syscall(113,1,(long)&now,0,0,0,0)&&now.tv_sec>0);
    struct timespec zero={0};errno=0;
    assert(klb_syscall(115,7,0,(long)&zero,0,0,0)==-1);
    assert(errno==original_errno_from_linux(95)&&original_errno_to_linux(errno)==95);
    assert(klb_syscall(172,0,0,0,0,0,0)==getpid());
    assert(klb_syscall(174,0,0,0,0,0,0)==((unsigned (*)(void))original_lookup("getuid"))());
    int sockets[2];assert(!klb_syscall(199,1,1|0x800|0x80000,0,(long)sockets,0,0));
    assert(fcntl(sockets[0],F_GETFL)&O_NONBLOCK);assert(fcntl(sockets[1],F_GETFD)&FD_CLOEXEC);
    close(sockets[0]);close(sockets[1]);
    assert(!unlink("entry")&&!fchdir(cwd));close(dir);close(cwd);assert(!rmdir(directory));
    puts("PASS shared properties, fortified file ownership and Linux syscall delegates");
}
