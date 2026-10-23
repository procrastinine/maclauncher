.text
.p2align 14
.global fixture_value
.type fixture_value,%function
fixture_value:
    mov x18,x0
    sub x0,x18,#224
    ret
.size fixture_value,.-fixture_value
.section .note.GNU-stack,"",%progbits
