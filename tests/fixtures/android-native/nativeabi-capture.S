.text
.p2align 2
.globl _klj_abi_capture_target
_klj_abi_capture_target:
    adrp x9, _klj_abi_capture_values@PAGE
    add x9, x9, _klj_abi_capture_values@PAGEOFF
    stp x0, x1, [x9]
    stp x2, x3, [x9, #16]
    stp x4, x5, [x9, #32]
    stp x6, x7, [x9, #48]
    stp d0, d1, [x9, #64]
    stp d2, d3, [x9, #80]
    stp d4, d5, [x9, #96]
    stp d6, d7, [x9, #112]
    adrp x10, _klj_abi_capture_stack@PAGE
    ldr w10, [x10, _klj_abi_capture_stack@PAGEOFF]
    add x9, x9, #128
    mov x11, sp
Lcapture_stack:
    cbz w10, Lcapture_done
    ldr x12, [x11], #8
    str x12, [x9], #8
    sub w10, w10, #1
    b Lcapture_stack
Lcapture_done:
    mov x0, #0x789
    ret
