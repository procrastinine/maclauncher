#include <algorithm>
#include <cassert>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <system_error>
#include <csignal>
#include <csetjmp>
#include <sys/mman.h>
#include <unistd.h>
#include DYNARMIC_EXCEPTION_SOURCE

#if PHYSICAL_LOG
extern "C" void klj_android_log_initialize(void);
#endif

static sigjmp_buf recovery;
static volatile sig_atomic_t signal_seen;
static void* denied_page;
static void next_signal_owner(int signal,siginfo_t* info,void*) {
    signal_seen=(signal==SIGBUS||signal==SIGSEGV)&&info->si_addr==denied_page;
    siglongjmp(recovery,1);
}

int main() {
    using namespace Dynarmic::Backend;
    RegisterHandler();
#if PHYSICAL_LOG
    klj_android_log_initialize();
#endif
    assert(!fclose(stderr));
    arm_thread_state64_t state{}, result{};
    state.__pc=0x12340000;state.__lr=0x12340008;
    state.__sp=0x22340000;state.__fp=0x22340010;
    for(unsigned i=0;i<29;++i)state.__x[i]=0xabc00000+i;
    mach_exception_data_type_t code[]={KERN_INVALID_ADDRESS,0x23450000};
    int flavor=ARM_THREAD_STATE64;mach_msg_type_number_t count=ARM_THREAD_STATE64_COUNT;
    bool threw=false;kern_return_t reply=KERN_SUCCESS;
    errno=EDOM;
    try {
        reply=catch_mach_exception_raise_state(0,EXC_BAD_ACCESS,code,2,&flavor,
            reinterpret_cast<thread_state_t>(&state),ARM_THREAD_STATE64_COUNT,
            reinterpret_cast<thread_state_t>(&result),&count);
    } catch (const std::system_error& error) {
        assert(error.code().value()==EBADF);threw=true;
    }
#if ORIGINAL_REPORTER
    assert(threw);
    puts("PASS original reporter throws EBADF after guest fclose(stderr)");
#else
    assert(!threw&&reply==KERN_FAILURE&&errno==EDOM);
    assert(count==ARM_THREAD_STATE64_COUNT&&!memcmp(&state,&result,sizeof state));
    unsigned callbacks=0;
    mach_handler->AddCodeBlock({state.__pc,state.__pc+4,[&](u64 pc){++callbacks;return FakeCall{pc+16};}});
    reply=catch_mach_exception_raise_state(0,EXC_BAD_ACCESS,code,2,&flavor,
        reinterpret_cast<thread_state_t>(&state),ARM_THREAD_STATE64_COUNT,
        reinterpret_cast<thread_state_t>(&result),&count);
    assert(reply==KERN_SUCCESS&&errno==EDOM&&result.__pc==state.__pc+16&&callbacks==1);
    result.__pc=state.__pc;assert(!memcmp(&state,&result,sizeof state));
    struct sigaction action{},previous_bus{},previous_segv{};
    action.sa_sigaction=next_signal_owner;action.sa_flags=SA_SIGINFO;sigemptyset(&action.sa_mask);
    assert(!sigaction(SIGBUS,&action,&previous_bus)&&!sigaction(SIGSEGV,&action,&previous_segv));
    const size_t page_size=static_cast<size_t>(sysconf(_SC_PAGESIZE));
    denied_page=mmap(nullptr,page_size,PROT_NONE,MAP_PRIVATE|MAP_ANON,-1,0);assert(denied_page!=MAP_FAILED);
    if(!sigsetjmp(recovery,1)){asm volatile("ldr wzr, [%0]"::"r"(denied_page):"memory");assert(false);}
    assert(signal_seen&&callbacks==1);
    assert(!munmap(denied_page,page_size));
    assert(!sigaction(SIGBUS,&previous_bus,nullptr)&&!sigaction(SIGSEGV,&previous_segv,nullptr));
    // A malformed message is this dispatcher's own failure and remains a
    // physical diagnostic even when the guest has closed its FILE stream.
    flavor=-1;errno=EDOM;
    assert(catch_mach_exception_raise_state(0,EXC_BAD_ACCESS,code,2,&flavor,
        reinterpret_cast<thread_state_t>(&state),ARM_THREAD_STATE64_COUNT,
        reinterpret_cast<thread_state_t>(&result),&count)==KERN_INVALID_ARGUMENT&&errno==EDOM);
    puts("PASS quiet unowned forwarding, owned fastmem callback, actual Mach-to-signal chain and protocol diagnostics after closed stderr");
#endif
    fflush(stdout);_Exit(0);
}
