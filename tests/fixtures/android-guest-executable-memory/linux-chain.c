#include <signal.h>
#include <stdint.h>
#include <ucontext.h>

/* Original Android headers define both records. The saved disposition is
 * supplied in the interrupted x1 so this function needs no loader relocations. */
void linux_chain_handler(int signal, siginfo_t *info, void *opaque) {
    ucontext_t *context=opaque;
    void (*previous)(int,siginfo_t *,void *)=(void *)(uintptr_t)context->uc_mcontext.regs[1];
    if(signal!=SIGILL||info->si_signo!=SIGILL||context->uc_mcontext.regs[0]!=0x1122){
        context->uc_mcontext.regs[0]=0xdead;context->uc_mcontext.pc+=4;return;
    }
    /* This raw-instruction fixture has no ELF constant-pool mapping. Volatile
     * scalar writes prevent Clang merging these stores into a .rodata load. */
    *(volatile uint64_t *)&context->uc_mcontext.regs[0]=0x3344;
    *(volatile uint64_t *)&context->uc_mcontext.fault_address=0xabcde000;
    /* A guest may forward a copied public ucontext rather than the original
     * rt_sigframe. Volatile copies keep this fixture import-free. */
    ucontext_t copied;
    volatile uint64_t *out=(void *)&copied;const volatile uint64_t *in=(void *)context;
    for(unsigned i=0;i<sizeof(copied)/sizeof(uint64_t);i++)out[i]=in[i];
    copied.uc_flags=0x1234;copied.uc_link=(void *)(uintptr_t)0x5678;
    uint64_t fault=context->uc_mcontext.fault_address;
    previous(signal,info,&copied);
    out=(void *)context;in=(void *)&copied;
    for(unsigned i=0;i<sizeof(copied)/sizeof(uint64_t);i++)out[i]=in[i];
    if(context->uc_mcontext.regs[0]!=0xccdd||!(context->uc_sigmask.sig[0]&(1UL<<(SIGUSR1-1)))||
       context->uc_flags!=0x1234||context->uc_link!=(void *)(uintptr_t)0x5678||context->uc_mcontext.fault_address!=fault)
        context->uc_mcontext.regs[0]=0xdead;
    else context->uc_mcontext.regs[0]=0xaabb;
}
