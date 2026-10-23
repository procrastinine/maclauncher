.syntax unified
.arm
.fpu neon
.text
.global interrupted, resumed, nested, faulting, undefined, breakpoint, signal_handler
.type interrupted,%function
interrupted:
    mov r8, lr
    bl ready
    mov lr, r8
    mov r4, #7
    mov r5, #0
1:  add r5, r5, #1
    b 1b
.type resumed,%function
resumed:
    adc r0, r0, r4
    vmov r1, s0
    vmrs r2, fpscr
    stmia r6, {r0-r2}
    vmov r3, r7, d31
    str r7, [r6, #12]
    bx lr
.type nested,%function
nested:
    adds r0, r0, #1
    bx lr
.type faulting,%function
faulting:
    ldr r0, [r0]
    bx lr
.type undefined,%function
undefined:
    udf #0
.type breakpoint,%function
breakpoint:
    bkpt #0
.type signal_handler,%function
signal_handler:
    ldr r3, [r2, #56] // interrupted r6 in original ucontext
    str r0, [r3, #16]
    str r1, [r3, #20]
    str sp, [r3, #24]
    ldr r0, [r1]
    str r0, [r3, #28]
    mov r0, #99
    str r0, [r2, #32] // return r0
    mov r0, #64
    str r0, [r2, #108] // high signal-mask word
    mov r0, #171
    str r0, [r2, #492] // VFP final register word
    mov r0, #0x00400000
    str r0, [r2, #496] // FPSCR
    bx lr
