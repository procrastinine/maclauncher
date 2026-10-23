use aim_linux_abi::diag::{self, Fault};
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};

static HANDLED: AtomicU32 = AtomicU32::new(0);
const ERRNO: i32 = 173;

unsafe extern "C" fn handler(sig: i32, info: *mut libc::siginfo_t, context: *mut libc::c_void) {
    unsafe {
        let uc = &mut *(context as *mut libc::ucontext_t);
        let mc = &mut *uc.uc_mcontext;
        let ss = &mut mc.__ss;
        if ss.__x[0] != 0x1122 || ss.__x[5] != 0x5566 || ss.__x[16] != 0x7788 { libc::_exit(81); }
        let fault = Fault {
            sig: if sig == libc::SIGILL { libc::SIGILL } else { libc::SIGSEGV },
            pc: ss.__pc, lr: ss.__lr, fp: ss.__fp, sp: ss.__sp,
            addr: (*info).si_addr as u64, esr: mc.__es.__esr, x: ss.__x, instruction: None,
        };
        *libc::__error() = ERRNO;
        diag::observe_native_startup_fault(&fault, 1, 719);
        if *libc::__error() != ERRNO { libc::_exit(82); }
        HANDLED.fetch_add(1, Relaxed);
        ss.__pc = if ss.__pc==0 {ss.__lr} else {ss.__pc+4};
    }
}

#[inline(never)]
unsafe fn hardware_faults() {
    unsafe {
        std::arch::asm!(
            "mov x0, #0x1122", "mov x5, #0x5566", "mov x16, #0x7788",
            ".inst 0x00000000", // actual hardware SIGILL
            "mov x1, #0", ".inst 0xf9000020", // actual unmapped null store
            out("x0") _, out("x1") _, out("x5") _, out("x16") _, options(nostack),
        );
    }
}

#[inline(never)]
unsafe fn indirect_fault() {
    unsafe {std::arch::asm!(
        "mov x0,#0x1122","mov x5,#0x5566","mov x16,#0x7788",
        "mov x1,#0","blr x1",
        out("x0") _,out("x1") _,out("x5") _,out("x16") _,out("x30") _,
    );}
}

fn main() {
    let mode = std::env::args().nth(1).unwrap();
    let start = hardware_faults as *const () as u64 & !16383;
    let name = if mode == "system" { "/system/lib64/libprobe.so" } else { "/data/app/probe/lib/arm64/libprobe.so" };
    diag::register_module(start, start + 16384, name.to_owned());
    if mode=="origin" {
        let indirect=indirect_fault as *const () as u64 & !16383;
        diag::register_module(indirect,indirect+16384,name.to_owned());
    }
    if mode == "reused" { diag::register_module(start, start + 16384, "/system/lib64/libreplacement.so".to_owned()); }
    diag::configure_native_startup_observation(mode != "disabled");
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = handler as *const () as usize;
        action.sa_flags = libc::SA_SIGINFO;
        libc::sigemptyset(&mut action.sa_mask);
        for sig in [libc::SIGILL, libc::SIGSEGV, libc::SIGBUS] {
            assert_eq!(libc::sigaction(sig, &action, std::ptr::null_mut()), 0);
        }
        hardware_faults();
        assert_eq!(HANDLED.load(Relaxed), 2);
        if mode=="origin" {indirect_fault();assert_eq!(HANDLED.load(Relaxed),3);}
        if mode == "bounds" || mode == "retired" {
            let mut sockets = [0; 2];
            if mode == "retired" {
                assert_eq!(libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, sockets.as_mut_ptr()), 0);
                assert_eq!(libc::close(sockets[1]), 0);
                diag::log_to(sockets[0]);
            }
            let fault = Fault { sig: libc::SIGSEGV, pc: start, lr: 0, fp: 0, sp: 0,
                addr: 0, esr: 0, x: [0; 29], instruction: None };
            for _ in 0..40 {
                *libc::__error() = ERRNO;
                diag::observe_native_startup_fault(&fault, 1, 719);
                assert_eq!(*libc::__error(), ERRNO);
            }
            if mode == "retired" { diag::log_to(2); assert_eq!(libc::close(sockets[0]), 0); }
        }
    }
    println!("PASS actual app-library SIGILL and MAPERR preserve registers, guest continuation and errno ({mode})");
}
