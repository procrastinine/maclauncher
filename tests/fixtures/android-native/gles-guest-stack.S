.text
.p2align 2
.globl _guest_blit
_guest_blit:
    stp x19, x30, [sp, #-32]!
    mov x19, x0
    sub sp, sp, #32
    // AAPCS64 mask and filter occupy separate eight-byte stack slots.
    mov w9, #0x4000
    str x9, [sp]
    mov w9, #0x2600
    str x9, [sp, #8]
    mov w0, #0
    mov w1, #0
    mov w2, #2
    mov w3, #2
    mov w4, #0
    mov w5, #0
    mov w6, #2
    mov w7, #2
    blr x19
    add sp, sp, #32
    ldp x19, x30, [sp], #32
    ret

.globl _guest_mixed
_guest_mixed:
    stp x19, x30, [sp, #-32]!
    mov x19, x0
    mov x10, x1
    sub sp, sp, #32
    mov w9, #251
    str x9, [sp]
    mov w9, #-1234
    str x9, [sp, #8]
    str x10, [sp, #16]
    movz x9, #0xef90
    movk x9, #0xabcd, lsl #16
    movk x9, #0x1234, lsl #32
    movk x9, #0x5678, lsl #48
    str x9, [sp, #24]
    mov w0, #1
    mov w1, #2
    mov w2, #3
    mov w3, #4
    mov w4, #5
    mov w5, #6
    mov w6, #7
    mov w7, #8
    fmov s0, #1.5
    fmov d1, #2.5
    blr x19
    add sp, sp, #32
    ldp x19, x30, [sp], #32
    ret

.globl _guest_upload3d
_guest_upload3d:
    stp x19, x30, [sp, #-32]!
    mov x19, x0
    mov x10, x1
    sub sp, sp, #32
    mov w9, #0x1908
    str x9, [sp]
    mov w9, #0x1401
    str x9, [sp, #8]
    str x10, [sp, #16]
    mov w0, #0x8c1a
    mov w1, #0
    mov w2, #0
    mov w3, #0
    mov w4, #0
    mov w5, #2
    mov w6, #2
    mov w7, #1
    blr x19
    add sp, sp, #32
    ldp x19, x30, [sp], #32
    ret
