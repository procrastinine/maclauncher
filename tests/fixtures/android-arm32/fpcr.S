.syntax unified
.arm
.fpu neon
.text
.p2align 2

// Ordinary ARMv7 vector dot/add blocks. Keep their instruction sequence intact
// so the same block exercises original scalar VFP loads and NEON arithmetic.
.global fpcr_dot
.type fpcr_dot,%function
fpcr_dot:
    vldr s0, [r0]
    vldr s4, [r1]
    vldr s2, [r0, #4]
    vldr s6, [r1, #4]
    vmul.f32 d16, d2, d0
    vmul.f32 d17, d3, d1
    vadd.f32 d0, d17, d16
    vmov r0, s0
    bx lr

.global fpcr_add
.type fpcr_add,%function
fpcr_add:
    vldr s0, [r1]
    vldr s4, [r2]
    vldr s2, [r1, #4]
    vldr s6, [r2, #4]
    vadd.f32 d0, d2, d0
    vadd.f32 d1, d3, d1
    vstr s0, [r0]
    vstr s2, [r0, #4]
    bx lr

.type fpcr_mixed,%function
fpcr_mixed:
    vldr s0, [r0, #4]
    vldr s2, [r0, #8]
    vldr s4, [r0, #12]
    vldr s6, [r0, #16]
    vmul.f32 d16, d2, d0
    vadd.f32 s8, s0, s4
    vmul.f32 d17, d3, d1
    vadd.f32 d0, d17, d16
    vstr s8, [r0, #36]
    vmov r1, s0
    str r1, [r0, #40]
    vmrs r1, fpscr
    str r1, [r0, #44]
    bx lr

.global fpcr_case
.type fpcr_case,%function
fpcr_case:
    push {r4-r8, lr}
    mov r4, r0
    ldr r1, [r4]
    vmsr fpscr, r1
    add r0, r4, #4
    add r1, r4, #12
    bl fpcr_dot
    str r0, [r4, #20]
    add r0, r4, #24
    add r1, r4, #4
    add r2, r4, #12
    bl fpcr_add
    vmrs r1, fpscr
    str r1, [r4, #32]
    mov r0, r4
    bl fpcr_mixed
    // A physical host callback must observe the host's original control mode.
    bl checkpoint
    ldr r1, [r4, #48]
    vmsr fpscr, r1
    vldr s0, [r4, #4]
    vldr s4, [r4, #12]
    vadd.f32 s8, s0, s4
    vmul.f32 d16, d2, d0
    vstr s8, [r4, #52]
    vmrs r1, fpscr
    str r1, [r4, #56]
    mov r0, #0
    pop {r4-r8, pc}

.global fpcr_loop
.type fpcr_loop,%function
fpcr_loop:
    push {r4-r8, lr}
    mov r4, r0
    mov r5, r1
    mov r6, #0
    vmsr fpscr, r6
1:
    add r0, r4, #4
    add r1, r4, #12
    bl fpcr_dot
    eor r6, r6, r0
    add r0, r4, #24
    add r1, r4, #4
    add r2, r4, #12
    bl fpcr_add
    subs r5, r5, #1
    bne 1b
    mov r0, r6
    pop {r4-r8, pc}

.global fpcr_fault
.type fpcr_fault,%function
fpcr_fault:
    vldr s0, [r0, #4]
    vldr s4, [r0, #12]
    vadd.f32 d0, d2, d0
    vldr s8, [r1]
    bx lr
