.text
.global simd_stack_elf
.type simd_stack_elf,%function
simd_stack_elf:
    mov x5,sp
    mov sp,x0
    mov x16,#0x1616
    mov x17,#0x1717
    movi v31.16b,#0x31
    movi v0.16b,#0x40
    movi v1.16b,#0x41
    movi v2.16b,#0x42
    mov x18,x1
    cmp x0,x0
    mrs x4,nzcv
    .inst 0x0db22fff
    mrs x7,nzcv
    stp x16,x17,[x2]
    stp x4,x7,[x2,#16]
    mov x0,sp
    mov sp,x5
    ret
.size simd_stack_elf,.-simd_stack_elf

.global alu_stack_elf
.type alu_stack_elf,%function
alu_stack_elf:
    mov x5,sp
    mov sp,x0
    mov x16,#0x1616
    mov x17,#0x1717
    mov x18,x1
    cmp x0,x0
    mrs x4,nzcv
    .inst 0xd102ea5f
    mrs x7,nzcv
    stp x16,x17,[x2]
    stp x4,x7,[x2,#16]
    mov x0,sp
    mov sp,x5
    ret
.size alu_stack_elf,.-alu_stack_elf
