.text
.p2align 2
.globl _probe_jump_registers
_probe_jump_registers:
  stp x29, x30, [sp, #-16]!
  mov x29, sp
  sub sp, sp, #400
  stp x19, x20, [sp, #256]
  stp x21, x22, [sp, #272]
  stp x23, x24, [sp, #288]
  stp x25, x26, [sp, #304]
  stp x27, x28, [sp, #320]
  stp d8, d9, [sp, #336]
  stp d10, d11, [sp, #352]
  stp d12, d13, [sp, #368]
  stp d14, d15, [sp, #384]
  .irp reg,19,20,21,22,23,24,25,26,27,28
    mov x\reg, #\reg
  .endr
  .irp reg,8,9,10,11,12,13,14,15
    fmov d\reg, #\reg
  .endr
  mov x0, sp
  mov w1, #0
  bl _klj_jump_sigsetjmp
  cbnz w0, Lresumed
  .irp reg,19,20,21,22,23,24,25,26,27,28
    mov x\reg, #0
  .endr
  .irp reg,8,9,10,11,12,13,14,15
    fmov d\reg, xzr
  .endr
  mov x0, sp
  mov w1, #43
  bl _klj_jump_siglongjmp
Lresumed:
  cmp w0, #43
  bne Lfailed
  .irp reg,19,20,21,22,23,24,25,26,27,28
    cmp x\reg, #\reg
    bne Lfailed
  .endr
  .irp reg,8,9,10,11,12,13,14,15
    fmov d0, #\reg
    fcmp d\reg, d0
    bne Lfailed
  .endr
  mov w0, #0
  b Lrestore
Lfailed:
  mov w0, #1
Lrestore:
  ldp x19, x20, [sp, #256]
  ldp x21, x22, [sp, #272]
  ldp x23, x24, [sp, #288]
  ldp x25, x26, [sp, #304]
  ldp x27, x28, [sp, #320]
  ldp d8, d9, [sp, #336]
  ldp d10, d11, [sp, #352]
  ldp d12, d13, [sp, #368]
  ldp d14, d15, [sp, #384]
  add sp, sp, #400
  ldp x29, x30, [sp], #16
  ret
