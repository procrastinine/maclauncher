#include <sys/ucontext.h>
#include <signal.h>
#include "signal-context.h"
#define CHECK(T,F,U,G) _Static_assert(offsetof(T,F)==offsetof(U,G),#G)
_Static_assert(sizeof(SignalInfo32)==sizeof(siginfo_t),"Original ARM siginfo");
_Static_assert(sizeof(SignalContext32)==sizeof(ucontext_t),"Original ARM ucontext");
_Static_assert(sizeof(SignalMachine32)==sizeof(mcontext_t),"Original ARM machine context");
CHECK(SignalContext32,flags,ucontext_t,uc_flags);
CHECK(SignalContext32,link,ucontext_t,uc_link);
CHECK(SignalContext32,stack,ucontext_t,uc_stack);
CHECK(SignalContext32,machine,ucontext_t,uc_mcontext);
CHECK(SignalContext32,mask,ucontext_t,uc_sigmask64);
CHECK(SignalContext32,registers,ucontext_t,uc_regspace);
CHECK(SignalMachine32,registers,mcontext_t,arm_r0);
CHECK(SignalMachine32,cpsr,mcontext_t,arm_cpsr);
CHECK(SignalMachine32,fault,mcontext_t,fault_address);
CHECK(SignalInfo32,data.sender.value,siginfo_t,si_value);
CHECK(SignalInfo32,data.sender.value,siginfo_t,si_status);
CHECK(SignalInfo32,data.sender.userTime,siginfo_t,si_utime);
CHECK(SignalInfo32,data.sender.systemTime,siginfo_t,si_stime);
CHECK(SignalInfo32,data.timer.value,siginfo_t,si_value);
CHECK(SignalInfo32,data.timer.privateValue,siginfo_t,si_sys_private);
CHECK(SignalInfo32,data.fault.address,siginfo_t,si_addr);
CHECK(SignalInfo32,data.poll.fd,siginfo_t,si_fd);
_Static_assert(offsetof(SignalVfp32,fpscr)==8+offsetof(struct user_vfp,fpscr),"Original VFP status");
_Static_assert(offsetof(SignalVfp32,fpexc)==8+sizeof(struct user_vfp),"Original VFP exceptions");
_Static_assert(sizeof(struct sigaction64)==20,"Original ARM64-mask sigaction record");
_Static_assert(offsetof(struct sigaction64,sa_mask)==12,"Original kernel mask offset");
