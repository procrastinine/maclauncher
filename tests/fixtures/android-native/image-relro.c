#include <assert.h>
#include <dlfcn.h>
#include <mach/mach.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>

static int protection(const void *pointer) {
    vm_address_t address=(vm_address_t)pointer;vm_size_t size=0;
    vm_region_basic_info_data_64_t info={0};mach_msg_type_number_t count=VM_REGION_BASIC_INFO_COUNT_64;mach_port_t object;
    assert(vm_region_64(mach_task_self(),&address,&size,VM_REGION_BASIC_INFO_64,(vm_region_info_t)&info,&count,&object)==KERN_SUCCESS);
    if(object)mach_port_deallocate(mach_task_self(),object);
    return info.protection;
}
static unsigned callbacks;
static int observe(const void *relocated,const void *writable) {
    ++callbacks;
    assert(protection(relocated)==VM_PROT_READ);
    assert(protection(writable)&VM_PROT_WRITE);
    return 7;
}
static sigjmp_buf denied;
static void fault(int signal){assert(signal==SIGBUS||signal==SIGSEGV);siglongjmp(denied,1);}
int main(int argc,char **argv) {
    assert(argc==3);void *runtime=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);
    if(!runtime){fprintf(stderr,"%s\n",dlerror());return 2;}
    void *(*load)(const char *)=dlsym(runtime,"kl_load");
    void *(*symbol)(void *,const char *)=dlsym(runtime,"kl_sym");
    void (*initialize)(void *)=dlsym(runtime,"kl_run_init"),(*unload)(void *)=dlsym(runtime,"kl_unload");
    void (*interpose)(const char *,void *)=dlsym(runtime,"kl_interpose");
    const char *(*error)(void)=dlsym(runtime,"kl_error");
    assert(load&&symbol&&initialize&&unload&&interpose&&error);interpose("relro_observe",observe);
    void *image=load(argv[2]);if(!image){fprintf(stderr,"%s\n",error());return 3;}
    int *value=symbol(image,"writable_value"),*result=symbol(image,"constructor_result");
    void (*write_slot)(void **)=symbol(image,"write_slot");assert(write_slot);
    void *volatile *relocated=symbol(image,"relocated");assert(value&&result&&relocated);
    assert(*relocated==value&&*value==17&&*result==0&&callbacks==0);
    initialize(image);assert(*value==18&&*result==7&&callbacks==1);
    initialize(image);assert(callbacks==1);
    struct sigaction handler={0},old_bus,old_segv;handler.sa_handler=fault;sigemptyset(&handler.sa_mask);
    assert(!sigaction(SIGBUS,&handler,&old_bus)&&!sigaction(SIGSEGV,&handler,&old_segv));
    if(!sigsetjmp(denied,1)){write_slot((void **)relocated);assert(!"RELRO store was allowed");}
    assert(!sigaction(SIGBUS,&old_bus,NULL)&&!sigaction(SIGSEGV,&old_segv,NULL));
    assert(*relocated==value);++*value;assert(*value==19);unload(image);
    puts("PASS ELF64 relocation precedes read-only constructors, denied stores and writable neighbors");
}
