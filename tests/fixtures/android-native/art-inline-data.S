.text
.global _start
.type _start,%function
_start:
    adr x8, constants
    ldr w9,[x8,#16]
    mov w10,#0xc25b
    movk w10,#0x3956,lsl#16
    cmp w9,w10
    b.ne fail
    ldr w9,[x8,#32]
    mov w10,#0x5152
    movk w10,#0x983e,lsl#16
    cmp w9,w10
    b.ne fail
    ldr w9,[x8,#48]
    mov w10,#0x664b
    movk w10,#0xa81a,lsl#16
    cmp w9,w10
    b.ne fail
    // Real reserved-register code reached through an original address and
    // indirect call immediately after instruction-shaped literal data.
    adr x16, indirect
    blr x16
    cmp x0,#42
    b.ne fail
    mov x0,#1
    adr x1,message
    mov x2,#message_end-message
    mov x8,#64
    svc #0
    mov x0,#0
    b exit
fail:
    mov x0,#31
exit:
    mov x8,#93
    svc #0
    b exit
.balign 16
constants:
    // Standard SHA256 constants deliberately emitted without object symbols.
    .word 0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5
    .word 0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5
    .word 0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7
    .word 0xa81a664b,0xc24b8b70,0xc76c51a3,0x428a2f98
indirect:
    mov x18,#40
    add x0,x18,#2
    ret
message:
    .ascii "PASS stripped inline data and reachable x18\n"
message_end:
.size _start,.-_start
