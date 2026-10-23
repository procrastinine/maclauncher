// Call the actual guest entry using Linux AAPCS64 varargs, not Darwin varargs.
.text
.p2align 2
.globl _probe_log_assert
_probe_log_assert:
    stp x29, x30, [sp, #-32]!
    mov x29, sp
    mov x16, x0
    adrp x0, condition@PAGE
    add x0, x0, condition@PAGEOFF
    adrp x1, tag@PAGE
    add x1, x1, tag@PAGEOFF
    adrp x2, format@PAGE
    add x2, x2, format@PAGEOFF
    mov w3, #-17
    movz x4, #0xdef0
    movk x4, #0x9abc, lsl #16
    movk x4, #0x5678, lsl #32
    movk x4, #0x1234, lsl #48
    adrp x5, text@PAGE
    add x5, x5, text@PAGEOFF
    mov w6, #21
    mov w7, #22
    sub sp, sp, #16
    mov x9, #23
    str x9, [sp]
    fmov d0, #1.5
    fmov d1, #-2.25
    fmov d2, #3.0
    fmov d3, #4.0
    fmov d4, #5.0
    fmov d5, #6.0
    fmov d6, #7.0
    fmov d7, #8.0
    fmov d16, #9.5
    str d16, [sp, #8]
    blr x16
    brk #0 // The assertion must not return.+.section __TEXT,__cstring,cstring_literals
condition: .asciz "owned ABI assertion"
tag: .asciz "ShimProbe"
text: .asciz "value"
format: .asciz "integer=%d hex=%llx text=%s float=%.2f second=%.2f ints=%d,%d,%d tail=%.0f,%.0f,%.0f,%.0f,%.0f,%.0f,%.1f"
