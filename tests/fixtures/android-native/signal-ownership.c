#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ucontext.h>
#include <sys/mman.h>
#include <unistd.h>
#include "klepton.h"
#include "kl_target.h"
#include "kl_env.h"
#include "kl_x18.h"
#include "signal-bridge.h"
#include "executable-memory/jvm.h"
#include <stdatomic.h>
static int native_count,guest_count,guest_signal;
static int reraised_signal;
static volatile sig_atomic_t real_fault,real_native_count,real_guest_count;
static sigjmp_buf fault_return;
static void *fault_page;
static uintptr_t real_guest_pc,real_guest_end;
static uintptr_t guest_handler_start,guest_handler_end;
static const uintptr_t guest_pc=0x123400;
const char *kl_addr_image(const void *address,size_t *offset){(void)offset;uintptr_t pc=(uintptr_t)address;return pc==guest_pc||(real_fault==2&&pc>=real_guest_pc&&pc<real_guest_end)||(pc>=guest_handler_start&&pc<guest_handler_end)?"guest.so":NULL;}
int kl_env_on(const char *name,int fallback){(void)name;(void)fallback;return 0;}
kl_guest_kind kl_driver_kind(void){return KL_GUEST_UNITY;}
static void native_handler(int sig,siginfo_t *info,void *context){assert(sig==SIGBUS&&info&&context);native_count++;}
static void guest_handler(int sig){guest_count++;guest_signal=sig;if(real_fault){assert(real_fault==2);real_guest_count++;siglongjmp(fault_return,1);}}
static void hardware_handler(int sig,siginfo_t *info,void *context){
    assert(real_fault==1&&info&&context&&klj_signal_is_hardware_fault(sig,info));
    assert(info->si_addr==fault_page);real_native_count++;siglongjmp(fault_return,1);
}
static volatile sig_atomic_t software_count;
static void software_handler(int sig,void *raw,void *context){
    klj_signal_info *info=raw;assert(sig==31&&info&&context&&info->signal==31&&info->code==0);assert(info->data.sender.pid==getpid());software_count++;
}
__attribute__((noinline)) static void faulting_store(void *page){*(volatile unsigned char *)page=1;}
static int probe_raise(int sig){reraised_signal=sig;return 0;}
#define raise probe_raise
#include "signal-unit.c"
#undef raise
int main(void){
    assert(SI_USER>0);
    siginfo_t mismatched={.si_signo=SIGABRT,.si_code=BUS_ADRALN};
    assert(!klj_signal_is_hardware_fault(SIGABRT,&mismatched));
    mismatched.si_signo=SIGSYS;assert(!klj_signal_is_hardware_fault(SIGSYS,&mismatched));
    for(int sig=1;sig<32;sig++){
        siginfo_t software={.si_signo=sig,.si_code=SI_USER};assert(!klj_signal_is_hardware_fault(sig,&software));
        software.si_code=SI_QUEUE;assert(!klj_signal_is_hardware_fault(sig,&software));
        software.si_code=SI_TIMER;assert(!klj_signal_is_hardware_fault(sig,&software));
    }
    struct sigaction native={.sa_sigaction=native_handler,.sa_flags=SA_SIGINFO|SA_ONSTACK|SA_RESTART};sigemptyset(&native.sa_mask);
    assert(!sigaction(SIGBUS,&native,NULL));
    bionic_sigaction guest={.handler=guest_handler};
    // The original native handler must survive even when the APK asks for no
    // previous handler and the callback is a native ABI gate for an ARM32 APK.
    assert(!klb_sigaction(7,&guest,NULL));
    ucontext_t context={0};struct __darwin_mcontext64 machine={0};context.uc_mcontext=&machine;
    siginfo_t info={.si_signo=SIGBUS,.si_code=BUS_ADRALN};
    machine.__ss.__pc=0x567800;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(native_count==1&&guest_count==0);
    machine.__ss.__pc=guest_pc;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(native_count==1&&guest_count==1&&guest_signal==7);
    bionic_sigaction old={0};assert(!klb_sigaction(7,NULL,&old));assert(old.handler==guest_handler);
    guest.handler=(void *)SIG_IGN;assert(!klb_sigaction(7,&guest,NULL));
    machine.__ss.__pc=0x567800;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(native_count==2&&guest_count==1);
    machine.__ss.__pc=guest_pc;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(native_count==2&&guest_count==1);
    guest.handler=(void *)SIG_DFL;assert(!klb_sigaction(7,&guest,NULL));
    machine.__ss.__pc=0x567800;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(native_count==3&&guest_count==1);
    guest.handler=guest_handler;guest.flags=(int32_t)KL_SA_RESETHAND;assert(!klb_sigaction(7,&guest,NULL));
    struct sigaction kernel={0};assert(!sigaction(SIGBUS,NULL,&kernel));
    assert(kernel.sa_sigaction==kl_sig_x18_tramp&&(kernel.sa_flags&SA_ONSTACK)&&(kernel.sa_flags&SA_RESTART)&&!(kernel.sa_flags&SA_RESETHAND));
    machine.__ss.__pc=0x567800;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(native_count==4&&guest_count==1);assert(!klb_sigaction(7,NULL,&old)&&old.handler==guest_handler);
    machine.__ss.__pc=guest_pc;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(guest_count==2);assert(!klb_sigaction(7,NULL,&old)&&old.handler==(void *)SIG_DFL);
    machine.__ss.__pc=0x567800;kl_sig_x18_tramp(SIGBUS,&info,&context);
    assert(native_count==5);assert(!sigaction(SIGBUS,NULL,&kernel)&&kernel.sa_sigaction==kl_sig_x18_tramp);
    // A native default/ignored disposition must never become guest Crashlytics
    // reentry. Intercept only raise to retain this test process; sigaction is
    // the real kernel disposition operation used by the production adapter.
    native.sa_handler=SIG_IGN;native.sa_flags=0;assert(!sigaction(SIGSEGV,&native,NULL));
    guest.flags=0;guest.handler=guest_handler;assert(!klb_sigaction(11,&guest,NULL));
    machine.__ss.__pc=0x567800;info.si_signo=SIGSEGV;info.si_code=SEGV_ACCERR;
    kl_sig_x18_tramp(SIGSEGV,&info,&context);
    assert(guest_count==2&&reraised_signal==0);
    native.sa_handler=SIG_DFL;assert(!sigaction(SIGSEGV,&native,NULL));
    assert(!klb_sigaction(11,&guest,NULL));
    kl_sig_x18_tramp(SIGSEGV,&info,&context);
    assert(guest_count==2&&reraised_signal==SIGSEGV);
    assert(!sigaction(SIGSEGV,NULL,&kernel)&&kernel.sa_handler==SIG_DFL);
    // Real Darwin raise() reports positive SI_USER while its PC is in libc.
    // This must reach Linux31, rather than restoring SIGSYS's native default.
    assert(!sigaction(SIGSYS,&native,NULL));
    guest=(bionic_sigaction){.flags=KL_SA_SIGINFO,.handler=software_handler};assert(!klb_sigaction(31,&guest,NULL));
    reraised_signal=0;assert(!raise(SIGSYS));assert(software_count==1&&reraised_signal==0);
    // Exercise the same dispatcher with actual CPU protection faults. Saved
    // native handlers retain the real Darwin context, while an instruction
    // attributed to the guest keeps its Android callback ownership.
    long page_size=sysconf(_SC_PAGESIZE);assert(page_size>0);
    fault_page=mmap(NULL,(size_t)page_size,PROT_NONE,MAP_PRIVATE|MAP_ANON,-1,0);assert(fault_page!=MAP_FAILED);
    native=(struct sigaction){.sa_sigaction=hardware_handler,.sa_flags=SA_SIGINFO|SA_ONSTACK};sigemptyset(&native.sa_mask);
    assert(!sigaction(SIGBUS,&native,NULL)&&!sigaction(SIGSEGV,&native,NULL));
    guest=(bionic_sigaction){.handler=guest_handler};assert(!klb_sigaction(7,&guest,NULL)&&!klb_sigaction(11,&guest,NULL));
    real_fault=1;if(!sigsetjmp(fault_return,1))faulting_store(fault_page);
    assert(real_native_count==1&&real_guest_count==0);
    real_guest_pc=(uintptr_t)faulting_store;real_guest_end=real_guest_pc+128;
    real_fault=2;if(!sigsetjmp(fault_return,1))faulting_store(fault_page);
    assert(real_native_count==1&&real_guest_count==1&&(guest_signal==7||guest_signal==11));
    real_fault=0;assert(!munmap(fault_page,(size_t)page_size));
    puts("PASS host VM faults preserve native context; real hardware faults retain native/guest ownership and real software SIGSYS reaches Linux31");
    return 0;
}
