#include <signal.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <unistd.h>
#include <ucontext.h>
#include <sys/wait.h>

static volatile uint64_t observed;
static volatile uint64_t replacement;

static void handler(int signal, siginfo_t *info, void *opaque) {
    (void)info;
    ucontext_t *context=opaque;
    observed=context->uc_mcontext.regs[18];
    context->uc_mcontext.regs[18]=replacement;
    if(signal==SIGILL)context->uc_mcontext.pc+=4;
}

__attribute__((naked)) static uint64_t synchronous(void) {
    __asm__("mov x18,#0x1234\n.inst 0\nmov x0,x18\nret");
}

__attribute__((naked)) static uint64_t asynchronous(pid_t process __attribute__((unused))) {
    __asm__("mov x18,#0x2345\nmov x1,#10\nmov x8,#129\nsvc #0\nmov x0,x18\nret");
}

__attribute__((naked)) static uint64_t current_x18(void) { __asm__("mov x0,x18\nret"); }

static void *worker(void *unused) {
    (void)unused;
    uint64_t restored=synchronous();
    return (void *)(uintptr_t)(observed==0x1234&&restored==replacement);
}

int main(void) {
    struct sigaction action={.sa_sigaction=handler,.sa_flags=SA_SIGINFO};
    sigemptyset(&action.sa_mask);
    if(sigaction(SIGILL,&action,0)||sigaction(SIGUSR1,&action,0))return 30;
    replacement=0x5678;
    uint64_t restored=synchronous();
    printf("synchronous guest x18: observed=%#lx restored=%#lx\n",(unsigned long)observed,(unsigned long)restored);
    if(observed!=0x1234||restored!=replacement)return 31;
    replacement=0x6789;
    restored=asynchronous(getpid());
    printf("asynchronous guest x18: observed=%#lx restored=%#lx\n",(unsigned long)observed,(unsigned long)restored);
    if(observed!=0x2345||restored!=replacement)return 32;
    replacement=0x789a;
    pthread_t thread;void *result;
    if(pthread_create(&thread,0,worker,0)||pthread_join(thread,&result))return 33;
    if(result!=(void *)1||current_x18()!=0x6789)return 34;
    puts("thread guest x18: child restored=0x789a parent preserved=0x6789");
    pid_t child=fork();
    if(child<0)return 35;
    if(!child)_exit(current_x18()==0x6789?0:36);
    int status;
    if(waitpid(child,&status,0)!=child||!WIFEXITED(status)||WEXITSTATUS(status)||current_x18()!=0x6789)return 37;
    puts("fork guest x18: child inherited=0x6789 parent preserved=0x6789");
    puts("PASS original Bionic signal handlers read and restore virtual x18");
    return 0;
}
