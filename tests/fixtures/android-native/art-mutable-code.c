#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <dlfcn.h>
#include <elf.h>
#include <fcntl.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <ucontext.h>
#include <unistd.h>
#include <time.h>
static const size_t page=16384,span=512UL<<20;
static volatile sig_atomic_t traps,denied;
static volatile uintptr_t denied_address;
static void unexpected(int sig,const siginfo_t *info,const ucontext_t *context){
    char text[]="unexpected original signal00 pc=0000000000000000 address=0000000000000000\n";
    text[26]='0'+sig/10;text[27]='0'+sig%10;
    const char hex[]="0123456789abcdef";uint64_t pc=context->uc_mcontext.pc,address=(uintptr_t)info->si_addr;
    for(unsigned n=0;n<16;n++){text[32+n]=hex[(pc>>(60-4*n))&15];text[57+n]=hex[(address>>(60-4*n))&15];}
    (void)write(STDERR_FILENO,text,sizeof text-1);_exit(125);
}
static void handled(int sig,siginfo_t *info,void *opaque){
    assert(info&&info->si_code>0);ucontext_t *context=opaque;
    if(sig==SIGTRAP)traps++;else{if(sig!=SIGSEGV||(uintptr_t)info->si_addr!=denied_address)unexpected(sig,info,context);denied++;}
    context->uc_mcontext.pc+=4;
}
static const uint32_t first[]={0xaa0003f2,0xd1038240,0xd65f03c0};
static const uint32_t second[]={0xaa0003f2,0xd1038640,0xd65f03c0};
static const uint32_t original_svc[]={0xd2801588,0xd4000001,0xd65f03c0};
static const uint32_t original_tls[]={0xd53bd040,0xd65f03c0};
extern const uint32_t self_store[],self_store_end[],exclusive[],exclusive_end[];
__asm__(".text\n.p2align 2\n.global self_store\nself_store:\n"
        "adr x1, 1f\nmov w2, #0x2400\nmovk w2, #0x9100, lsl #16\nstr w2, [x1]\n1: add x0, x0, #1\nret\n"
        ".global self_store_end\nself_store_end:\n"
        ".p2align 2\n.global exclusive\nexclusive:\n"
        "1: ldxr x1, [x0]\nadd x1, x1, #1\nstxr w2, x1, [x0]\ncbnz w2, 1b\nmov x0, x1\nret\n"
        ".global exclusive_end\nexclusive_end:\n");
static uint64_t call(void *site,uint64_t input){return ((uint64_t(*)(uint64_t))site)(input);}
static void writable_executable(void *site){
    FILE *file=fopen("/proc/self/maps","r");assert(file);char line[1024],mode[8];unsigned long lo,hi;int found=0;
    while(fgets(line,sizeof line,file))if(sscanf(line,"%lx-%lx %7s",&lo,&hi,mode)==3&&lo<=(uintptr_t)site&&(uintptr_t)site<hi){assert(!strncmp(mode,"rwx",3));found=1;break;}
    fclose(file);assert(found);
}
static void *reserve(void){void *base=mmap(0,span,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(base!=MAP_FAILED);return base;}
static void *middle(void *base){return (char*)base+(256UL<<20);}
struct Executing {void *site;unsigned ready,done;};
static void *during_enrollment(void *opaque){
    struct Executing *state=opaque;
    do{assert(call(state->site,1000)==776);__atomic_store_n(&state->ready,1,__ATOMIC_RELEASE);}while(!__atomic_load_n(&state->done,__ATOMIC_ACQUIRE));
    return 0;
}
static void *concurrent_calls(void *opaque){for(int n=0;n<80;n++){uint64_t value=call(opaque,1000);assert(value==775||value==776);}return 0;}
static void *concurrent_writes(void *opaque){uint32_t *counter=opaque;for(int n=0;n<80;n++)__atomic_fetch_add(counter,1,__ATOMIC_SEQ_CST);return 0;}
struct AsyncData{volatile uint64_t count;volatile uint32_t stop;};
static struct AsyncData *signal_data;
static void asynchronous(int sig){assert(sig==SIGUSR1);signal_data->stop=1;}
static void *signal_sender(void *opaque){usleep(20000);assert(!pthread_kill(*(pthread_t*)opaque,SIGUSR1));return 0;}
extern const uint32_t async_store_loop[],async_store_loop_end[];
__asm__(".text\n.p2align 2\n.global async_store_loop\nasync_store_loop:\n"
        "1: ldr x2, [x0]\nadd x2, x2, #1\nstr x2, [x0]\nldr w3, [x0, #8]\ncbz w3, 1b\nmov x0, x2\nret\n"
        ".global async_store_loop_end\nasync_store_loop_end:\n");
static void asynchronous_progress(void *site){
    void *routine=(char*)site+4096;memcpy(routine,async_store_loop,(uintptr_t)async_store_loop_end-(uintptr_t)async_store_loop);
    signal_data=mmap(0,page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(signal_data!=MAP_FAILED);memset(signal_data,0,page);
    struct sigaction action={.sa_handler=asynchronous},previous;sigemptyset(&action.sa_mask);assert(!sigaction(SIGUSR1,&action,&previous));
    pthread_t self=pthread_self(),sender;assert(!pthread_create(&sender,0,signal_sender,&self));alarm(5);
    uint64_t result=call(routine,(uintptr_t)signal_data);alarm(0);assert(!pthread_join(sender,0)&&signal_data->stop==1&&result==signal_data->count&&result>0);
    assert(!sigaction(SIGUSR1,&previous,0));puts("PASS original asynchronous signal interrupts CPU-bound private-data stores");
    int ready[2];assert(!pipe(ready));pid_t child=fork();assert(child>=0);
    if(!child){close(ready[0]);signal_data->stop=0;assert(write(ready[1],"r",1)==1);close(ready[1]);(void)call(routine,(uintptr_t)signal_data);_exit(124);}
    close(ready[1]);char byte=0;assert(read(ready[0],&byte,1)==1&&byte=='r');close(ready[0]);usleep(20000);
    struct timespec start,end;assert(!clock_gettime(CLOCK_MONOTONIC,&start));assert(!kill(child,SIGTERM));alarm(5);int status;assert(waitpid(child,&status,0)==child);alarm(0);assert(!clock_gettime(CLOCK_MONOTONIC,&end));
    assert(WIFSIGNALED(status)&&WTERMSIG(status)==SIGTERM);printf("PASS original SIGTERM interrupts CPU-bound stores elapsed_us=%lld\n",(long long)(end.tv_sec-start.tv_sec)*1000000+(end.tv_nsec-start.tv_nsec)/1000);
    assert(!munmap(signal_data,page));signal_data=0;
}
static void cached_library(const char *name){
    void *library=dlopen(name,RTLD_NOW|RTLD_LOCAL);
    if(!library)fprintf(stderr,"dlopen: %s\n",dlerror());assert(library);
    void *function=dlsym(library,"fixture_value");assert(function&&call(function,1000)==776);
    assert(memcmp(function,first,sizeof first));
    puts("PASS cached original library was translated and executes");
    int descriptor=open(name,O_RDONLY|O_CLOEXEC);assert(descriptor>=0);Elf64_Ehdr header;
    assert(pread(descriptor,&header,sizeof header,0)==sizeof header);uint64_t offset=UINT64_MAX;
    for(unsigned n=0;n<header.e_phnum;n++){Elf64_Phdr segment;assert(pread(descriptor,&segment,sizeof segment,header.e_phoff+n*header.e_phentsize)==sizeof segment);if(segment.p_type==PT_LOAD&&(segment.p_flags&PF_X)){offset=segment.p_offset&~(page-1);break;}}
    assert(offset!=UINT64_MAX);void *shared=mmap(0,page,PROT_READ,MAP_SHARED,descriptor,(off_t)offset);close(descriptor);assert(shared!=MAP_FAILED);
    errno=0;int denied_write=mprotect(shared,page,PROT_READ|PROT_WRITE|PROT_EXEC);
    if(denied_write==0)fputs("readonly shared source unexpectedly acquired write permission\n",stderr);
    assert(denied_write==-1&&errno==EACCES);assert(!munmap(shared,page));
    puts("PASS cached original shared readonly mapping preserves source permissions");
    void *base=(void*)((uintptr_t)function&~(page-1));
    if(mprotect(base,page,PROT_READ|PROT_WRITE|PROT_EXEC)){
        fprintf(stderr,"cached library mprotect: %s (%d)\n",strerror(errno),errno);abort();
    }
    assert(!memcmp(function,first,sizeof first)&&call(function,1000)==776);
    ((volatile uint32_t*)function)[1]=second[1];assert(call(function,1000)==775);
    puts("PASS cached original library restores source words and mutable execution");
    assert(!madvise(base,page,MADV_DONTNEED)&&call(function,1000)==776);
    puts("PASS cached original library discard reloads authenticated original bytes");
    assert(!dlclose(library));puts("PASS cached original library retires mappings normally");
}
int main(int argc,char **argv){
    setvbuf(stdout,0,_IONBF,0);assert((argc==2||argc==3)&&!chdir(argv[1]));
    const int host_packet=argc==3&&!strcmp(argv[2],"--host-packet");
    if(argc==3&&!host_packet){cached_library(argv[2]);return 0;}
    struct sigaction action={.sa_sigaction=handled,.sa_flags=SA_SIGINFO};sigemptyset(&action.sa_mask);
    assert(!sigaction(SIGTRAP,&action,0)&&!sigaction(SIGSEGV,&action,0));
    int fd=open("original.code",O_CREAT|O_EXCL|O_RDWR|O_CLOEXEC,0600);assert(fd>=0);
    assert(!ftruncate(fd,2*page)&&pwrite(fd,first,sizeof first,0)==sizeof first);close(fd);
    fd=open("original.code",O_RDONLY|O_CLOEXEC);assert(fd>=0);
    void *base=reserve(),*site=middle(base);
    assert(mmap(site,page,PROT_READ|PROT_EXEC,MAP_PRIVATE|MAP_FIXED,fd,0)==site);close(fd);
    uint32_t fetched=*(uint32_t*)site;assert((fetched&0xffe0001f)==0xd4200000);assert(call(site,1000)==776);
    puts("PASS original far source before mutable enrollment");
    pthread_t enrollment_thread;struct Executing running={.site=site};
    assert(!pthread_create(&enrollment_thread,0,during_enrollment,&running));
    while(!__atomic_load_n(&running.ready,__ATOMIC_ACQUIRE))sched_yield();
    assert(!mprotect(site,page,PROT_READ|PROT_WRITE|PROT_EXEC));
    __atomic_store_n(&running.done,1,__ATOMIC_RELEASE);assert(!pthread_join(enrollment_thread,0));
    puts("PASS original concurrent executor survives mutable enrollment");
    assert(!memcmp(site,first,sizeof first)&&call(site,1000)==776);writable_executable(site);
    puts("PASS original bytes, virtual RWX and NX fault entry");
    ((volatile uint32_t*)site)[1]=second[1];assert(call(site,1000)==775&&!memcmp(site,second,sizeof second));
    puts("PASS original native writer continuation and read visibility");
    uint32_t *battery=(uint32_t*)((char*)site+2048);memset(battery,0xa5,64);
    assert(syscall(0x48430000UL,1UL,1UL,battery,64UL)==0);
    assert(battery[2]>=1&&battery[2]<=5&&battery[3]>=1&&battery[3]<=11);
    puts("PASS original typed Darwin host module writes an enrolled argument block");
    if(host_packet){
        uint64_t *clock=(uint64_t*)((char*)site+2112);*clock=0;
        assert(syscall(0x48430000UL,0x4d4cUL,1UL,clock,8UL)==0&&*clock>0);
        puts("PASS original C extension writes an enrolled typed clock packet");
        uint64_t *log=(uint64_t*)((char*)site+2144);
        log[0]=4;log[1]=(uintptr_t)"A64Mutable";log[2]=(uintptr_t)"original readonly packet";
        assert(!mprotect(site,page,PROT_READ|PROT_EXEC));errno=0;
        assert(syscall(0x48430000UL,0x4d4cUL,1UL,clock,8UL)==-1&&errno==EFAULT);
        assert(syscall(0x48430000UL,0x4d4cUL,14UL,log,24UL)>=0);
        assert(!mprotect(site,page,PROT_READ|PROT_WRITE|PROT_EXEC));
        puts("PASS original C packet access preserves readonly inputs and rejects writes");
    }
    memcpy(site,original_svc,sizeof original_svc);
    assert(call(site,0)==(uint64_t)getpid());puts("PASS original SVC dispatch in enrolled code");
    memcpy(site,original_tls,sizeof original_tls);
    assert(call(site,0)==(uintptr_t)__builtin_thread_pointer());
    puts("PASS original SVC dispatch and thread-pointer state in enrolled code");
    memcpy(site,self_store,(uintptr_t)self_store_end-(uintptr_t)self_store);
    assert(call(site,1000)==1009&&((uint32_t*)site)[4]==0x91002400);
    puts("PASS original self-store publishes before the next instruction fetch");
    memcpy(site,exclusive,(uintptr_t)exclusive_end-(uintptr_t)exclusive);uint64_t counter=31;
    assert(call(site,(uintptr_t)&counter)==32&&counter==32);
    puts("PASS original exclusive retry loop in enrolled code");
    memcpy(site,first,sizeof first);pthread_t a,b;
    assert(!pthread_create(&a,0,concurrent_calls,site));
    for(int n=0;n<80;n++)((volatile uint32_t*)site)[1]=(n&1)?first[1]:second[1];
    assert(!pthread_join(a,0));
    uint64_t *native_exclusive=(uint64_t*)((char*)site+1024);*native_exclusive=0;
    alarm(5);assert(call((void*)exclusive,(uintptr_t)native_exclusive)==1&&*native_exclusive==1);alarm(0);
    puts("PASS original native exclusive writer resumes across owned write fault");
    uint32_t *shared=(uint32_t*)((char*)site+1040);*shared=0;
    assert(!pthread_create(&a,0,concurrent_writes,shared)&&!pthread_create(&b,0,concurrent_writes,shared));
    assert(!pthread_join(a,0)&&!pthread_join(b,0)&&*shared==160);
    puts("PASS concurrent original fetches and native atomic writers");
    asynchronous_progress(site);
    assert(!mprotect(site,page,PROT_READ|PROT_EXEC));uint32_t prior=((uint32_t*)site)[1];
    denied_address=(uintptr_t)site+4;((volatile uint32_t*)site)[1]=0;denied_address=0;assert(denied==1&&((volatile uint32_t*)site)[1]==prior);
    assert(!mprotect(site,page,PROT_READ|PROT_WRITE|PROT_EXEC));memcpy(site,second,sizeof second);
    puts("PASS original signal and RX write denial without changing source bytes");
    void *moved_base=reserve(),*moved=middle(moved_base);
    assert(mremap(site,page,2*page,MREMAP_MAYMOVE|MREMAP_FIXED,moved)==moved);
    assert(call(moved,1000)==775);writable_executable(moved);writable_executable((char*)moved+page);
    assert(!mprotect((char*)moved+page,page,PROT_READ|PROT_WRITE|PROT_EXEC));
    ((volatile uint32_t*)((char*)moved+page))[0]=19;assert(*(uint32_t*)((char*)moved+page)==19);
    puts("PASS original move, growth and independently owned source tail");
    void *copy_base=reserve(),*copy=middle(copy_base);
    assert(mremap(moved,2*page,2*page,MREMAP_MAYMOVE|MREMAP_FIXED|MREMAP_DONTUNMAP,copy)==copy);
    assert(call(copy,1000)==775&&call(moved,1000)==776);
    ((volatile uint32_t*)copy)[1]=0xd1038a40;assert(call(copy,1000)==774&&call(moved,1000)==776);
    assert(!madvise(copy,2*page,MADV_DONTNEED)&&call(copy,1000)==776);
    puts("PASS original DONTUNMAP, private reload and source isolation");
    pid_t child=fork();assert(child>=0);
    if(!child){assert(call(copy,1000)==776);((volatile uint32_t*)copy)[1]=second[1];assert(call(copy,1000)==775);_exit(0);}
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    assert(call(copy,1000)==776);
    puts("PASS original fork preserves original views and private write isolation");
    const uint32_t genuine[]={fetched,0xd65f03c0};memcpy(copy,genuine,sizeof genuine);
    assert(call(copy,17)==17&&traps==1);
    puts("PASS genuine original BRK is distinct from historical fetched veneer");
    void *anonymous=mmap(0,page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(anonymous!=MAP_FAILED);
    memcpy(anonymous,first,sizeof first);assert(!mprotect(anonymous,page,PROT_READ|PROT_EXEC));assert(call(anonymous,1000)==776);
    assert(!mprotect(anonymous,page,PROT_READ|PROT_WRITE|PROT_EXEC)&&!memcmp(anonymous,first,sizeof first));
    assert(!madvise(anonymous,page,MADV_DONTNEED));for(size_t n=0;n<page;n++)assert(((uint8_t*)anonymous)[n]==0);
    assert(!munmap(anonymous,page)&&!munmap(base,span)&&!munmap(moved_base,span)&&!munmap(copy_base,span));
    puts("PASS original anonymous discard and complete mutable mapping retirement");return 0;
}
