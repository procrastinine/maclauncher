#define _DARWIN_C_SOURCE 1
#include <assert.h>
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

int main(int argc,char **argv){
    assert(argc==4);int observe=!strcmp(argv[3],"observe");
    void *runtime=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!runtime){puts(dlerror());return 2;}
    void *(*lookup)(const char *)=dlsym(runtime,"kl_shim_lookup");assert(lookup);
    long (*conf)(int)=lookup("sysconf");int (*pagesize)(void)=lookup("getpagesize");
    unsigned long (*auxiliary)(unsigned long)=lookup("getauxval");
    int (*residency)(void *,size_t,unsigned char *)=lookup("mincore");
    int (*sync_pages)(void *,size_t,int)=lookup("msync");
    long (*raw)(long,long,long,long,long,long,long)=dlsym(runtime,"klb_syscall");
    assert(conf&&pagesize&&auxiliary&&residency&&sync_pages&&raw);
    size_t page=(size_t)getpagesize();assert((size_t)pagesize()==page&&(size_t)conf(0x27)==page&&auxiliary(6)==page);
    unsigned char *memory=mmap(NULL,256<<10,PROT_READ|PROT_WRITE,MAP_ANON|MAP_PRIVATE,-1,0);assert(memory!=MAP_FAILED);
    size_t imported_page=0,raw_page=0;unsigned char vector=0;
    for(size_t n=4096;n<(256<<10);n*=2){if(!imported_page&&!residency(memory+n,1,&vector))imported_page=n;if(!raw_page&&!raw(232,(long)(memory+n),1,(long)&vector,0,0,0))raw_page=n;}
    printf("PAGES advertised=%zu imported-mincore=%zu raw232-mincore=%zu generic-forwarder=%d\n",page,imported_page,raw_page,(void *)residency==dlsym(RTLD_DEFAULT,"mincore"));
    if(observe){assert(!munmap(memory,256<<10));return 0;}
    assert(imported_page==page&&raw_page==page);
    for(size_t n=4096;n<page;n*=2){errno=0;assert(residency(memory+n,1,&vector)==-1&&errno==EINVAL);errno=0;assert(raw(232,(long)(memory+n),1,(long)&vector,0,0,0)==-1&&errno==EINVAL);}
    assert(!residency(memory,1,&vector)&&vector<=1);
    assert(!sync_pages(memory,page,0));
    void *(*load)(const char *,int)=lookup("dlopen"),*(*symbol)(void *,const char *)=lookup("dlsym");
    int (*close_image)(void *)=lookup("dlclose");assert(load&&symbol&&close_image);
    void *libc=load("libc.so",2);assert(libc&&symbol(libc,"mincore")==residency&&symbol(libc,"msync")==sync_pages);assert(!close_image(libc));
    Dl_info image;assert(dladdr((void *)lookup,&image)&&image.dli_fbase);
    FILE *plan=fopen(argv[2],"r");assert(plan);char name[160],target[160];unsigned long long offset;unsigned count=0;
    while(fscanf(plan,"%159s %159s %llx",name,target,&offset)==3){
        void *expected=offset==UINT64_MAX?dlsym(RTLD_DEFAULT,target):(char *)image.dli_fbase+(uintptr_t)offset;
        void *actual=lookup(name);if(!expected||actual!=expected)fprintf(stderr,"Native ABI owner collision: %s target=%s actual=%p expected=%p\n",name,target,actual,expected);
        assert(expected&&actual==expected);count++;
    }
    assert(!fclose(plan)&&count>0);assert(!munmap(memory,256<<10));
    printf("PASS%u programmatically discovered native ABI/generic table collisions retain their actual implementation owner\n",count);
    puts("PASS advertised page size, original Go mincore discovery, imported/dynamic/raw residency ABI and Linux msync flags");
}
