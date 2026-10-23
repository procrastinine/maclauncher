.text
.global _start
.type _start,%function
_start:
    // A live ordinary x18 value across timer preemption, not an SCS pointer.
    mov x18, #0x1234
    movz x10, #0xf080
    movk x10, #0x02fa, lsl #16
1:  add x18, x18, #1
    sub x18, x18, #1
    subs x10, x10, #1
    b.ne 1b
    cmp x18, #0x1000
    b.lo fail
    mov x11, #0x1234
    cmp x18, x11
    b.ne fail

    sub sp,sp,#256
    mov x15,sp
    movi v0.4s,#0x55
    // Original Cut the Rope fault sequence: ordinary SIMD pair base.
    add x18,x15,#0x10
    stp q0,q0,[x18,#-0x10]
    ldr w2,[sp]
    movz w3,#0x55
    cmp w2,w3
    b.ne fail
    // Original Temple Run 2 fault: floating-point load through x18.
    add x18,sp,#0
    ldr s2,[x18,#0x10]
    fmov w2,s2
    cmp w2,w3
    b.ne fail
    mov x18,#0x1234
    mov x19,#0x5678
    stp x18,x19,[sp,#-16]!
    mov x18,#1
    ldp x18,x19,[sp],#16
    mov x2,#0x1234
    cmp x18,x2
    b.ne fail
    mov w18,#0x80
    tbz w18,#7,fail
    cbz w18,fail
    sub w18,w18,#0x80
    cbnz w18,fail
    cmp x18,#0
    b.ne fail
    // Both VM bindings preserve the ordinary register around TP access.
    mrs x20,tpidr_el0
    mov x18,#0x5678
    msr tpidr_el0,x18
    mov x18,#0
    mrs x18,tpidr_el0
    mov x2,#0x5678
    cmp x18,x2
    b.ne fail
    msr tpidr_el0,x20
    mrs x18,ctr_el0
    cbz x18,fail
    // Terminal x18 instructions must not use Darwin's live x18 even briefly.
    mov x0,#1
    adr x18,callee
    blr x18
    cmp x0,#2
    b.ne fail
    adr x18,after_branch
    br x18
    b fail
after_branch:
    adr x18,after_return
    ret x18
    b fail
after_return:
    add sp,sp,#256
    mov x0,#1
    adr x1,message
    mov x2,#message_end-message
    mov x8,#64
    svc #0
    mov x0,#0
    mov x8,#93
    svc #0
callee:
    add x0,x0,#1
    ret
fail:
    mov x0,#21
    mov x8,#93
    svc #0
.size _start,.-_start
.section .rodata
message: .ascii "PASS shared x18: preemption SIMD memory width SP TP branches\n"
message_end:
