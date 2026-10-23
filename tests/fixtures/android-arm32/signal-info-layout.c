#include <signal.h>

// These bytes are emitted independently by the original NDK compiler for each
// ABI. No native or guest record layout is reproduced in the C++ fixture.
const siginfo_t signal_samples[]={
 {.si_signo=SIGUSR1,.si_code=SI_USER,.si_pid=123,.si_uid=456},
 {.si_signo=SIGUSR1,.si_code=SI_QUEUE,.si_pid=234,.si_uid=567,.si_value.sival_int=-17},
 {.si_signo=SIGALRM,.si_code=SI_TIMER,.si_tid=12,.si_overrun=34,.si_value.sival_ptr=(void*)0xfedcba98,.si_sys_private=56},
 {.si_signo=SIGCHLD,.si_code=CLD_EXITED,.si_pid=345,.si_uid=678,.si_status=7,.si_utime=-123,.si_stime=1234},
 {.si_signo=SIGPOLL,.si_code=POLL_IN,.si_band=-7,.si_fd=33},
 {.si_signo=SIGUSR1,.si_code=SI_SIGIO,.si_band=1234,.si_fd=45},
 {.si_signo=SIGUSR2,.si_code=POLL_OUT,.si_band=2345,.si_fd=67},
 {.si_signo=SIGSEGV,.si_code=SEGV_MAPERR,.si_addr=(void*)0x12345678},
 {.si_signo=SIGBUS,.si_code=BUS_MCEERR_AR,.si_addr=(void*)0x23456780,.si_addr_lsb=12},
 {.si_signo=SIGSEGV,.si_code=SEGV_BNDERR,.si_addr=(void*)0x34567890,.si_lower=(void*)0x34567000,.si_upper=(void*)0x34567fff},
 {.si_signo=SIGSEGV,.si_code=SEGV_PKUERR,.si_addr=(void*)0x45678900,.si_pkey=42},
 {.si_signo=SIGTRAP,.si_code=TRAP_PERF,.si_addr=(void*)0x56789000,.si_perf_data=0xfedcba98,.si_perf_type=31,.si_perf_flags=1},
 {.si_signo=SIGSYS,.si_code=SYS_SECCOMP,.si_call_addr=(void*)0x67890000,.si_syscall=123,.si_arch=0x40000028},
 {.si_signo=SIGUSR1,.si_code=SI_KERNEL,.si_pid=456,.si_uid=789},
 {.si_signo=SIGILL,.si_code=ILL_ILLOPC,.si_addr=(void*)0x78900000},
};
