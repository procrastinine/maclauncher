/* Test-only managed exception diagnostics. The tail trampoline preserves guest
 * unwind frames and calls the original exception implementation unchanged. */
#include <jni.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>

void *klj_test_original_throw;
static const char *(*image_at)(const void*,size_t*);
static void *(*object_class)(void*);
static const char *(*class_name)(void*);
static void (*format_exception)(void*,char*,int);
static void (*format_stack)(void*,char*,int);
static unsigned char *guest_base;
static size_t guest_span;
static int executable_pc(uintptr_t pc){
    if(pc<(uintptr_t)guest_base+4||pc>=(uintptr_t)guest_base+guest_span)return 0;
    uint64_t ph;uint16_t count,stride;memcpy(&ph,guest_base+32,8);memcpy(&count,guest_base+56,2);memcpy(&stride,guest_base+54,2);
    for(unsigned i=0;i<count;i++){
        unsigned char *p=guest_base+ph+i*stride;uint32_t type,flags;uint64_t va,size;
        memcpy(&type,p,4);memcpy(&flags,p+4,4);memcpy(&va,p+16,8);memcpy(&size,p+40,8);
        if(type==1&&(flags&1)&&pc-4>=(uintptr_t)guest_base+va&&pc<(uintptr_t)guest_base+va+size)return 1;
    }return 0;
}
static _Atomic unsigned reports;
static _Thread_local int reporting;
void klj_test_capture_throw(void *value,void *type,void *destructor){
    (void)destructor;
    if(reporting)return;
    const char *name=type?((const char**)type)[1]:NULL;
    if(!name||!strstr(name,"Il2CppExceptionWrapper"))return;
    reporting=1;void *exception=value?*(void**)value:NULL;
    const char *managed=exception&&object_class&&class_name?class_name(object_class(exception)):NULL;
    if(managed&&atomic_fetch_add(&reports,1)<32){
        char text[8192]={0};fprintf(stderr,"[il2cpp-exception] %s\n",managed);
        if(format_exception){format_exception(exception,text,sizeof(text));fprintf(stderr,"[il2cpp-exception] %s\n",text);}
        if(format_stack){format_stack(exception,text,sizeof(text));fprintf(stderr,"[il2cpp-exception] managed stack: %s\n",text);}
        uintptr_t end=(uintptr_t)pthread_get_stackaddr_np(pthread_self()),start=end-pthread_get_stacksize_np(pthread_self());
        uintptr_t *frame=__builtin_frame_address(0);
        for(unsigned i=0;i<80&&frame;i++){
            uintptr_t at=(uintptr_t)frame;if(at<start||at>end-2*sizeof(uintptr_t)||(at&15))break;
            const void *pc=(const void*)frame[1];size_t offset=0;const char *image=image_at?image_at(pc,&offset):NULL;
            fprintf(stderr,"[il2cpp-exception] frame %u %s+0x%zx (%p)\n",i,image?image:"host",offset,pc);
            uintptr_t next=frame[0];if(next<=at)break;frame=(uintptr_t*)next;
        }
        /* Optimized guest methods save LR without linking x29. Preserve those
         * potential frames separately, and require an actual call instruction
         * before each executable return PC rather than treating data as code. */
        uintptr_t first=(uintptr_t)__builtin_frame_address(0),last=first+65536;
        if(last>end)last=end;
        for(uintptr_t at=first;at+sizeof(uintptr_t)<=last;at+=sizeof(uintptr_t)){
            uintptr_t pc=*(uintptr_t*)at;if(!executable_pc(pc))continue;
            uint32_t instruction;memcpy(&instruction,(void*)(pc-4),4);
            if((instruction&0xfc000000u)!=0x94000000u&&(instruction&0xfffffc1fu)!=0xd63f0000u)continue;
            fprintf(stderr,"[il2cpp-exception] stack+0x%zx libil2cpp.so+0x%zx\n",at-first,pc-(uintptr_t)guest_base);
        }
    }
    reporting=0;
}
__asm__(".text\n.p2align 2\n.globl _klj_test_throw\n_klj_test_throw:\n"
        "stp x29, x30, [sp, #-48]!\nmov x29, sp\nstp x0, x1, [sp, #16]\nstr x2, [sp, #32]\n"
        "bl _klj_test_capture_throw\nldp x0, x1, [sp, #16]\nldr x2, [sp, #32]\nldp x29, x30, [sp], #48\n"
        "adrp x16, _klj_test_original_throw@PAGE\nldr x16, [x16, _klj_test_original_throw@PAGEOFF]\nbr x16\n");
extern void klj_test_throw(void);
static uint64_t u64(const void *p){uint64_t v;memcpy(&v,p,8);return v;}
static uint32_t u32(const void *p){uint32_t v;memcpy(&v,p,4);return v;}
static uint16_t u16(const void *p){uint16_t v;memcpy(&v,p,2);return v;}
static int install(void *library,void *image){
    void *(*base_of)(void*)=dlsym(library,"kl_base"),*(*symbol)(void*,const char*)=dlsym(library,"kl_sym");
    size_t(*span_of)(void*)=dlsym(library,"kl_span");if(!base_of||!symbol||!span_of)return 0;
    unsigned char *base=base_of(image);size_t span=span_of(image);if(span<64||memcmp(base,"\177ELF",4))return 0;
    guest_base=base;guest_span=span;
    uint64_t ph=u64(base+32),dynamic=0;for(unsigned i=0;i<u16(base+56);i++){unsigned char *p=base+ph+i*u16(base+54);if(u32(p)==2)dynamic=u64(p+16);}
    uint64_t strings=0,symbols=0,relocations=0,bytes=0;
    if(!dynamic)return 0;for(unsigned char *p=base+dynamic;p<base+span-16;p+=16){uint64_t tag=u64(p),value=u64(p+8);if(!tag)break;if(tag==5)strings=value;if(tag==6)symbols=value;if(tag==23)relocations=value;if(tag==2)bytes=value;}
    if(!strings||!symbols||!relocations||relocations+bytes>span)return 0;
    image_at=dlsym(library,"kl_addr_image");object_class=symbol(image,"il2cpp_object_get_class");class_name=symbol(image,"il2cpp_class_get_name");
    format_exception=symbol(image,"il2cpp_format_exception");format_stack=symbol(image,"il2cpp_format_stack_trace");
    for(uint64_t at=relocations;at<relocations+bytes;at+=24){
        uint64_t info=u64(base+at+8);if((uint32_t)info!=1026)continue;
        uint64_t sym=symbols+(info>>32)*24;if(sym+24>span)continue;
        const char *name=(const char*)base+strings+u32(base+sym);if(strcmp(name,"__cxa_throw"))continue;
        uint64_t slot=u64(base+at);if(slot+8>span)return 0;void **target=(void**)(base+slot);
        mach_vm_address_t region=(mach_vm_address_t)target;mach_vm_size_t length=0;vm_region_basic_info_data_64_t state;mach_msg_type_number_t count=VM_REGION_BASIC_INFO_COUNT_64;mach_port_t object=MACH_PORT_NULL;
        if(mach_vm_region(mach_task_self(),&region,&length,VM_REGION_BASIC_INFO_64,(vm_region_info_t)&state,&count,&object)!=KERN_SUCCESS)return 0;
        if(object!=MACH_PORT_NULL)mach_port_deallocate(mach_task_self(),object);
        size_t page=(size_t)getpagesize();void *start=(void*)((uintptr_t)target&~(page-1));
        if(mprotect(start,page,state.protection|PROT_WRITE))return 0;
        klj_test_original_throw=__atomic_load_n(target,__ATOMIC_ACQUIRE);__atomic_store_n(target,(void*)klj_test_throw,__ATOMIC_RELEASE);
        mprotect(start,page,state.protection);fprintf(stderr,"[il2cpp-exception] original exception import observed\n");return 1;
    }return 0;
}
static void *observe(void *argument){
    char *path=argument;void *library=NULL;void *(*find)(const char*)=NULL;
    for(unsigned attempt=0;attempt<6000;attempt++){
        if(!library)library=dlopen(path,RTLD_NOLOAD|RTLD_LAZY);
        if(library&&!find)find=dlsym(library,"kl_find_image");
        void *image=find?find("libil2cpp.so"):NULL;if(image&&install(library,image))break;
        usleep(5000);
    }free(path);return NULL;
}
JNIEXPORT jint JNICALL Agent_OnLoad(JavaVM *vm,char *options,void *reserved){
    (void)vm;(void)reserved;if(!options||!*options)return JNI_ERR;char *path=strdup(options);if(!path)return JNI_ERR;
    pthread_t thread;if(pthread_create(&thread,NULL,observe,path)){free(path);return JNI_ERR;}pthread_detach(thread);return JNI_OK;
}
