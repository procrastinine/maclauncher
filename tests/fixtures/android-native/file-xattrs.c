#include "file-xattrs.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static const char *directory;
const char *kl_guest_path(const char *file,char *mapped,size_t size) {
    if(file&&!strncmp(file,"/game/",6)){
        int length=snprintf(mapped,size,"%s/%s",directory,file+6);
        assert(length>0&&(size_t)length<size);return mapped;
    }
    return file;
}
typedef ssize_t (*path_get)(const char *,const char *,void *,size_t);
typedef ssize_t (*fd_get)(int,const char *,void *,size_t);
typedef ssize_t (*path_list)(const char *,char *,size_t);
typedef ssize_t (*fd_list)(int,char *,size_t);
typedef int (*path_set)(const char *,const char *,const void *,size_t,int);
typedef int (*attribute_fd_set)(int,const char *,const void *,size_t,int);
typedef int (*path_remove)(const char *,const char *);
typedef int (*fd_remove)(int,const char *);
static int contains(const char *names,ssize_t size,const char *name) {
    for(const char *at=names;at<names+size;at+=strlen(at)+1)if(!strcmp(at,name))return 1;
    return 0;
}
int main(int argc,char **argv) {
    assert(argc==2);directory=argv[1];char file[PATH_MAX],moved[PATH_MAX],link[PATH_MAX];
    snprintf(file,sizeof(file),"%s/file",directory);snprintf(moved,sizeof(moved),"%s/moved",directory);snprintf(link,sizeof(link),"%s/link",directory);
    int fd=open(file,O_CREAT|O_RDWR,0600);assert(fd>=0);
    assert(symlink("file",link)==0);
    const char *keys[]={"user.normal","user.nofollow","user.descriptor"};
    const unsigned char expected[]={0,255,42,0,127};char value[128],names[2048];
    for(int variant=0;variant<3;variant++){
        const char *prefix=variant==0?"":variant==1?"l":"f";char symbol[32];
#define RESOLVE(operation) (snprintf(symbol,sizeof(symbol),"%s%s",prefix,#operation),klj_xattr_lookup(symbol))
        void *get=RESOLVE(getxattr),*set=RESOLVE(setxattr),*list=RESOLVE(listxattr),*remove=RESOLVE(removexattr);
        assert(get&&set&&list&&remove);
        const char *name=keys[variant];
#define SET(bytes,size,flags) (variant==2?((attribute_fd_set)set)(fd,name,bytes,size,flags):((path_set)set)("/game/file",name,bytes,size,flags))
#define GET(bytes,size) (variant==2?((fd_get)get)(fd,name,bytes,size):((path_get)get)("/game/file",name,bytes,size))
        assert(SET(expected,sizeof(expected),1)==0);assert(SET(expected,sizeof(expected),1)==-1&&errno==EEXIST);
        assert(GET(NULL,0)==sizeof(expected));assert(GET(value,1)==-1&&errno==ERANGE);
        assert(GET(value,sizeof(value))==sizeof(expected)&&!memcmp(value,expected,sizeof(expected)));
        ssize_t size=variant==2?((fd_list)list)(fd,names,sizeof(names)):((path_list)list)("/game/file",names,sizeof(names));
        assert(size>0&&contains(names,size,name));assert(SET(NULL,0,2)==0);assert(GET(NULL,0)==0);
        assert(SET(expected,sizeof(expected),8)==-1&&errno==EINVAL);
        assert(variant==2?((fd_remove)remove)(fd,name)==0:((path_remove)remove)("/game/file",name)==0);
        assert(GET(value,sizeof(value))==-1&&errno==ENOATTR);
        assert(SET(expected,sizeof(expected),2)==-1&&errno==ENOATTR);
#undef RESOLVE
#undef SET
#undef GET
    }
    assert(klj_setxattr("/game/file",keys[0],expected,sizeof(expected),0)==0);
    assert(((path_get)klj_xattr_lookup("lgetxattr"))(link,keys[0],value,sizeof(value))==-1&&errno==ENOATTR);
    assert(rename(file,moved)==0);assert(((fd_get)klj_xattr_lookup("fgetxattr"))(fd,keys[0],value,sizeof(value))==sizeof(expected));
    assert(klj_getxattr("/game/moved",keys[0],value,sizeof(value))==sizeof(expected));
    assert(klj_xattr_lookup("unrelated")==NULL);assert(close(fd)==0);
    puts("PASS complete xattr syscall family: real bytes, flags, descriptors, namespace, symlinks and rename lifetime");
}
