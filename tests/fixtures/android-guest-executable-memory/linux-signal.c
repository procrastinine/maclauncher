#include <signal.h>
#include <stdint.h>
#include <ucontext.h>

/* Compiled against the original Android NDK UAPI, then loaded as import-free
 * AArch64 instructions. No hand-written Linux structure layout is involved. */
void linux_handler(int signal, siginfo_t *info, void *opaque) {
    ucontext_t *context=opaque;
    if(signal!=SIGILL || info->si_signo!=SIGILL ||
       (uintptr_t)info->si_addr!=context->uc_mcontext.pc ||
       context->uc_mcontext.regs[0]!=0x1122)
        context->uc_mcontext.regs[0]=0xdead;
    else context->uc_mcontext.regs[0]=0xaabb;
    context->uc_mcontext.pc+=4;
    context->uc_sigmask.sig[0]|=(1UL<<(SIGUSR2-1));
}

__attribute__((naked)) uint64_t linux_fault(void) {
    __asm__("mov x0,#0x1122\n.inst 0\nret");
}
