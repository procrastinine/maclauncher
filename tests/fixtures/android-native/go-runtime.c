#include <assert.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>
#include <mach/mach.h>
#include <mach/arm/thread_status.h>
#include <mach/mach_vm.h>
#include <signal.h>
#include <sys/ucontext.h>

static void (*enter)(void);
static uint64_t (*probe)(int);
static const char *(*image_at)(void *,size_t *);
static uintptr_t diagnostic_base,diagnostic_callback,diagnostic_slot;
static char *hex(char *out,uintptr_t value){for(int shift=60;shift>=0;shift-=4)*out++="0123456789abcdef"[(value>>shift)&15];return out;}
static void fault_context(int signal,siginfo_t *info,void *context){
    char line[512],*out=line;const char prefix[]="GO FIXTURE FAULT pc lr base fault x0 x1 x2 x8 x18 x26 x28 callback slot sp fp ";
    for(size_t i=0;i<sizeof prefix-1;i++)*out++=prefix[i];
    ucontext_t *native=context;
    if(native&&native->uc_mcontext){const struct __darwin_arm_thread_state64 *state=&native->uc_mcontext->__ss;
        uintptr_t values[]={state->__pc,state->__lr,diagnostic_base,(uintptr_t)info->si_addr,state->__x[0],state->__x[1],state->__x[2],state->__x[8],state->__x[18],state->__x[26],state->__x[28],diagnostic_callback,diagnostic_slot,state->__sp,state->__fp};
        for(size_t i=0;i<sizeof values/sizeof values[0];i++){out=hex(out,values[i]);*out++=' ';}
    }
    *out++='\n';(void)write(STDERR_FILENO,line,(size_t)(out-line));
    if(native&&native->uc_mcontext){
        uintptr_t locations[]={native->uc_mcontext->__ss.__sp,native->uc_mcontext->__ss.__x[28]};
        for(unsigned region=0;region<2;region++){
            uintptr_t words[64];mach_vm_size_t copied=0;
            if(mach_vm_read_overwrite(mach_task_self(),locations[region],sizeof words,(mach_vm_address_t)words,&copied)==KERN_SUCCESS){
                for(size_t i=0;i<copied/sizeof *words;i+=4){out=line;out=hex(out,locations[region]+i*sizeof *words);*out++=':';for(size_t j=i;j<i+4&&j<copied/sizeof *words;j++){*out++=' ';out=hex(out,words[j]);}*out++='\n';(void)write(STDERR_FILENO,line,(size_t)(out-line));}
            }
        }
    }
    _Exit(128+signal);
}
static void *watchdog(void *unused){
    (void)unused;sleep(5);thread_act_array_t threads=NULL;mach_msg_type_number_t count=0;
    fprintf(stderr,"STALLED fixture native threads\n");
    if(task_threads(mach_task_self(),&threads,&count)==KERN_SUCCESS){
        for(unsigned i=0;i<count;i++){
            arm_thread_state64_t state={0};mach_msg_type_number_t size=ARM_THREAD_STATE64_COUNT;
            if(thread_get_state(threads[i],ARM_THREAD_STATE64,(thread_state_t)&state,&size)==KERN_SUCCESS){
                uintptr_t addresses[]={arm_thread_state64_get_pc(state),arm_thread_state64_get_lr(state)};
                for(unsigned j=0;j<2;j++){Dl_info info={0};size_t offset=0;const char *image=image_at?image_at((void *)addresses[j],&offset):NULL;dladdr((void *)addresses[j],&info);
                    fprintf(stderr,"thread %u %s 0x%lx %s+0x%zx %s\n",i,j?"lr":"pc",(unsigned long)addresses[j],image?image:"",offset,info.dli_sname?info.dli_sname:"");}
            }
            mach_port_deallocate(mach_task_self(),threads[i]);
        }
        vm_deallocate(mach_task_self(),(vm_address_t)threads,count*sizeof(*threads));
    }
    fflush(stderr);_Exit(90);
}
static void *worker(void *argument){
    int rounds=(int)(uintptr_t)argument;enter();assert(probe(rounds)==(0x12340000u|(unsigned)rounds));printf("STAGE foreign callback %d returned\n",rounds);fflush(stdout);return NULL;
}
static double milliseconds(void){struct timespec value;assert(!clock_gettime(CLOCK_MONOTONIC,&value));return value.tv_sec*1000.0+value.tv_nsec/1000000.0;}
int main(int argc,char **argv){
    if(getenv("ANDROID_GO_FAULT_CONTEXT")){struct sigaction action={0};action.sa_sigaction=fault_context;action.sa_flags=SA_SIGINFO;assert(!sigaction(SIGBUS,&action,NULL));assert(!sigaction(SIGSEGV,&action,NULL));}
    assert(argc==9);void *runtime=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!runtime){puts(dlerror());return 2;}
    int (*configure)(const char *)=dlsym(runtime,"klj_process_ids_configure");assert(configure&&configure(argv[3])>0);
    void *(*lookup)(const char *)=dlsym(runtime,"kl_shim_lookup");enter=dlsym(runtime,"kl_thread_init");assert(lookup&&enter);
    image_at=dlsym(runtime,"kl_addr_image");pthread_t monitor;assert(!pthread_create(&monitor,NULL,watchdog,NULL));assert(!pthread_detach(monitor));
    void *(*load)(const char *,int)=lookup("dlopen"),*(*symbol)(void *,const char *)=lookup("dlsym");const char *(*error)(void)=lookup("dlerror");assert(load&&symbol&&error);
    enter();double start=milliseconds();puts("STAGE ordinary guest loader constructor");fflush(stdout);
    void *image=load(argv[2],2);if(!image){puts(error());return 3;}
    printf("STAGE constructor returned %.3fms\n",milliseconds()-start);fflush(stdout);
    probe=symbol(image,"ProbeGoRuntime");assert(probe);
    // Retain the original supplied ELF. Its unstripped metadata identifies
    // NumCPU's own backing field and the existing Go slice, not test exports.
    uintptr_t base=(uintptr_t)probe-strtoull(argv[4],NULL,16);
    diagnostic_base=base;
    diagnostic_callback=base+strtoull(argv[7],NULL,16);
    diagnostic_slot=*(const uintptr_t *)(base+strtoull(argv[8],NULL,16));
    printf("STAGE original callback expected %lx relocated %lx\n",(unsigned long)diagnostic_callback,(unsigned long)diagnostic_slot);fflush(stdout);
    const volatile int32_t *cpu_count=(const void *)(base+strtoull(argv[5],NULL,16));
    const volatile uintptr_t *allgs=(const void *)(base+strtoull(argv[6],NULL,16));
    long (*expected_cpus)(void)=dlsym(runtime,"kl_cpu_count");assert(expected_cpus);
    uintptr_t (*wait_ready)(void)=symbol(image,"_cgo_wait_runtime_init_done");
    void (*release_context)(uintptr_t)=symbol(image,"_cgo_release_context");assert(wait_ready&&release_context);
    uintptr_t context=wait_ready();release_context(context);
    printf("STAGE original Go CPU count %d agrees with existing CPU owner %ld\n",*cpu_count,expected_cpus());fflush(stdout);
    assert(*cpu_count==expected_cpus());
    if(getenv("ANDROID_GO_STARTUP_ONLY")){
        thread_act_array_t live=NULL;mach_msg_type_number_t count=0;
        assert(task_threads(mach_task_self(),&live,&count)==KERN_SUCCESS);
        assert(count<(unsigned)*cpu_count*4+64&&allgs[1]<(uintptr_t)*cpu_count+128);
        for(unsigned i=0;i<count;i++)mach_port_deallocate(mach_task_self(),live[i]);
        vm_deallocate(mach_task_self(),(vm_address_t)live,count*sizeof(*live));
        printf("PASS original Go CPU initialization: %d CPUs, %lu goroutine records, %u physical threads\n",*cpu_count,(unsigned long)allgs[1],count);return 0;
    }
    puts("STAGE original Go scheduler, goroutines, allocator/GC, timer and cgo callback");fflush(stdout);
    assert(probe(2)==0x12340002u);
    puts("STAGE main callback returned");fflush(stdout);
    pthread_t threads[4];for(uintptr_t i=0;i<4;i++)assert(!pthread_create(threads+i,NULL,worker,(void *)(i+1)));
    for(unsigned i=0;i<4;i++)assert(!pthread_join(threads[i],NULL));
    assert(allgs[1]<(uintptr_t)*cpu_count+128);
    thread_act_array_t live=NULL;mach_msg_type_number_t live_count=0;
    assert(task_threads(mach_task_self(),&live,&live_count)==KERN_SUCCESS);
    assert(live_count<(unsigned)*cpu_count*4+64);
    for(unsigned i=0;i<live_count;i++)mach_port_deallocate(mach_task_self(),live[i]);
    vm_deallocate(mach_task_self(),(vm_address_t)live,live_count*sizeof(*live));
    printf("STAGE bounded original Go goroutine records %lu and physical threads %u\n",(unsigned long)allgs[1],live_count);
    printf("PASS original Android Go shared runtime initialized, eight goroutines allocated/collected, timer/cgo returned and four foreign threads completed in%.3fms\n",milliseconds()-start);
    // Original Go's process-lifetime runtime retains its worker threads. Exit
    // this native fixture normally rather than unloading executing code.
    return 0;
}
