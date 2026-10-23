#include <assert.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <limits.h>
#include <string.h>
#include <stdio.h>
#include <unistd.h>
#include <errno.h>
static char root[PATH_MAX];
static void *kl_upstream_shim_lookup(const char *name){(void)name;return NULL;}
int kl_obbmap_is_vfd(int fd){(void)fd;return 0;}
int kl_errno_to_linux(int value){return value;}
ssize_t klj_readlinkat_path(int directory,const char *name,char *buffer,size_t length){return readlinkat(directory,name,buffer,length);}
#include "native-file-imports.h"
const char *kl_guest_path(const char *name,char *buffer,size_t size){
 if(name&&!strncmp(name,"/sdcard/",8)){snprintf(buffer,size,"%s/%s",root,name+8);return buffer;}return name;
}
int main(int argc,char **argv){
 assert(argc==2);snprintf(root,sizeof root,"%s",argv[1]);char link[PATH_MAX];assert(snprintf(link,sizeof link,"%s/link",root)>0);assert(!symlink("relative-target",link));
 char bytes[32];memset(bytes,'!',sizeof bytes);assert(klj_readlink_chk("/sdcard/link",bytes,8,sizeof bytes)==8);assert(!memcmp(bytes,"relative",8)&&bytes[8]=='!');
 int fd=open(root,O_RDONLY|O_DIRECTORY);assert(fd>=0);assert(klj_readlinkat_chk(fd,"link",bytes,31,sizeof bytes)==15&&!memcmp(bytes,"relative-target",15));assert(!close(fd));
 assert(klj_readlinkat_chk(-100,"/sdcard/link",bytes,31,sizeof bytes)==15);assert(klj_readlink_chk("/sdcard/missing",bytes,31,sizeof bytes)==-1&&errno==ENOENT);
 assert(klj_native_file_lookup("readlink")&&klj_native_file_lookup("readlinkat")&&klj_native_file_lookup("__readlink_chk")&&klj_native_file_lookup("__readlinkat_chk"));
 pid_t child=fork();assert(child>=0);if(!child){klj_readlink_chk("/sdcard/link",bytes,33,sizeof bytes);_exit(99);}int status;assert(waitpid(child,&status,0)==child&&WIFSIGNALED(status)&&WTERMSIG(status)==SIGABRT);
 puts("PASS shared readlink path/dirfd semantics, byte bounds and original FORTIFY overflow behavior");
}
