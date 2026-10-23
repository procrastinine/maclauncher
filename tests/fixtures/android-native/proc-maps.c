#include "proc-maps.h"
#include "guest-paths.h"
#include <jni.h>
#include <assert.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

extern void Java_maclauncher_android_framework_HostFilesystem_installNativePaths(JNIEnv *,jclass,jobjectArray,jobjectArray);
/* This fixture loads no Android ELF images. The real native VM/file walk and
 * configured namespace still own every region and pathname in this probe. */
int klj_proc_maps_image(uint64_t address,KljProcMapFile *file){(void)address;(void)file;return 0;}
JNIEXPORT void JNICALL Java_NativeProcMapsProbe_configure(JNIEnv *env,jclass type,jobjectArray guest,jobjectArray host){
    Java_maclauncher_android_framework_HostFilesystem_installNativePaths(env,type,guest,host);
}
static char *contents(int fd){
    struct stat status;assert(!fstat(fd,&status));assert(status.st_size>0&&status.st_size<16*1024*1024);
    char *text=malloc((size_t)status.st_size+1);assert(text);
    assert(lseek(fd,0,SEEK_SET)==0);size_t used=0;
    while(used<(size_t)status.st_size){ssize_t size=read(fd,text+used,(size_t)status.st_size-used);assert(size>0);used+=(size_t)size;}
    text[used]=0;return text;
}
static int permissions(const char *text,uintptr_t address,const char *expected){
    for(const char *line=text;*line;){
        unsigned long long begin=0,end=0;char mode[5]={0};
        assert(sscanf(line,"%llx-%llx %4s",&begin,&end,mode)==3);assert(begin<end);
        if(address>=begin&&address<end)return !strcmp(mode,expected);
        const char *next=strchr(line,'\n');assert(next);line=next+1;
    }
    return 0;
}
JNIEXPORT void JNICALL Java_NativeProcMapsProbe_probe(JNIEnv *env,jclass type,jstring value){
    (void)type;const char *root=(*env)->GetStringUTFChars(env,value,NULL);assert(root);
    size_t page=(size_t)sysconf(_SC_PAGESIZE);assert(page&&!(page&(page-1)));
    void *anonymous=mmap(NULL,page*3,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(anonymous!=MAP_FAILED);
    char file[4096],mapped[4096],path[4096];snprintf(file,sizeof file,"%s/mapped-file",root);
    int backing=open(file,O_CREAT|O_RDWR|O_TRUNC,0600);assert(backing>=0);assert(!ftruncate(backing,(off_t)page));
    void *image=mmap(NULL,page,PROT_READ,MAP_PRIVATE,backing,0);assert(image!=MAP_FAILED);
    assert(klj_guest_path_of_host(file,mapped,sizeof mapped)&&!strcmp(mapped,"/data/app/maps-fixture.so"));
    assert(!klj_guest_path_of_host("/System/Library/unexposed",mapped,sizeof mapped));
    assert(klj_proc_maps_self("/proc/self/maps",0)&&klj_proc_maps_self("/proc/thread-self/maps",0));
    assert(klj_proc_maps_self("/proc/123/maps",123)&&!klj_proc_maps_self("/proc/124/maps",123));
    assert(!klj_proc_maps_self("/proc/18446744073709551616/maps",123));
    assert(klj_proc_maps_native(root,path,sizeof path,123));int old=open(path,O_RDONLY);assert(old>=0);
    char link[96],origin[96];snprintf(link,sizeof link,"/proc/self/fd/%d",old);
    ssize_t originLength=klj_proc_maps_readlink(link,origin,sizeof origin,123);
    assert(originLength==14&&!memcmp(origin,"/proc/123/maps",14));
    int duplicate=dup(old);assert(duplicate>=0);snprintf(link,sizeof link,"/proc/123/fd/%d",duplicate);
    assert(klj_proc_maps_readlink(link,origin,sizeof origin,123)==14&&!memcmp(origin,"/proc/123/maps",14));
    char *first=contents(old);assert(permissions(first,(uintptr_t)anonymous,"rw-p"));
    assert(permissions(first,(uintptr_t)image,"r--p"));assert(strstr(first,"/data/app/maps-fixture.so"));
    assert(!strstr(first,file));struct stat before;assert(!fstat(old,&before));
    assert(!mprotect((char *)anonymous+page,page,PROT_READ));
    assert(klj_proc_maps_native(root,path,sizeof path,123));int current=open(path,O_RDONLY);assert(current>=0);
    char *second=contents(current);assert(permissions(second,(uintptr_t)anonymous,"rw-p"));
    assert(permissions(second,(uintptr_t)anonymous+page,"r--p"));
    assert(permissions(second,(uintptr_t)anonymous+page*2,"rw-p"));
    char *retained=contents(old);assert(!strcmp(retained,first));free(retained);
    struct stat after;assert(!fstat(current,&after));assert(before.st_ino!=after.st_ino);assert((after.st_mode&0777)==0444);
    for(int i=0;i<12;i++)assert(klj_proc_maps_native(root,path,sizeof path,123));
    assert(klj_proc_maps_readlink(link,origin,sizeof origin,123)==14&&!memcmp(origin,"/proc/123/maps",14));
    snprintf(mapped,sizeof mapped,"%s/proc/self",root);DIR *directory=opendir(mapped);assert(directory);int files=0;
    for(struct dirent *entry;(entry=readdir(directory));)if(strcmp(entry->d_name,".")&&strcmp(entry->d_name,"..")){assert(!strcmp(entry->d_name,"maps"));files++;}
    assert(files==1);closedir(directory);
    struct stat private;assert(!stat(root,&private));assert((private.st_mode&0777)==0700);
    close(old);close(current);close(duplicate);free(first);free(second);munmap(image,page);munmap(anonymous,page*3);close(backing);
    (*env)->ReleaseStringUTFChars(env,value,root);
}
