#include <assert.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc,char **argv){
    assert(argc==4);int saved=dup(1),physical[2];assert(saved>=0&&!pipe(physical));
    assert(dup2(physical[1],2)==2);close(physical[1]);
    void *core=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);assert(core);
    int(*configure)(const char *)=dlsym(core,"klj_process_ids_configure");assert(configure&&configure(argv[3])>0);
    void(*set_vm)(void *)=dlsym(core,"klj_set_guest_thread_vm");assert(set_vm);set_vm(NULL);
    void *(*lookup)(const char *)=dlsym(core,"kl_shim_lookup");assert(lookup);
    void(*enter)(void)=dlsym(core,"kl_thread_init");assert(enter);enter();
    void *(*load)(const char *,int)=lookup("dlopen");void *(*symbol)(void *,const char *)=lookup("dlsym");assert(load&&symbol);
    void *image=load(argv[2],2);assert(image);
    int(*probe)(void)=symbol(image,"NativeLogProbe");assert(probe);int result=probe();
    if(result){dprintf(saved,"guest logging probe failed %d\n",result);return 1;}
    char output[16384]={0};size_t size=0;
    while(size<sizeof output-1){struct pollfd p={.fd=physical[0],.events=POLLIN};int n=poll(&p,1,30);if(!n)break;assert(n>0);ssize_t got=read(physical[0],output+size,sizeof output-1-size);assert(got>0);size+=(size_t)got;}
    const char *expected[]={"[4/NativeWrite] after redirect\n","[5/NativePrint] number 42 works\n","[6/NativeWrite] after close\n","[6/NativePrint] closed 2\n"};
    for(size_t i=0;i<sizeof expected/sizeof expected[0];i++){const char *at=strstr(output,expected[i]);if(!at||strstr(at+1,expected[i])){dprintf(saved,"missing or repeated log %s physical output: %s\n",expected[i],output);return 2;}}
    assert(fcntl(1,F_GETFD)==-1&&fcntl(2,F_GETFD)==-1);
    dprintf(saved,"PASS original Android native log write/print survive real dup2 and fclose without feedback\n");
    close(physical[0]);close(saved);return 0;
}
