.text
.p2align 2
.global thread_pointer_x18
.type thread_pointer_x18,%function
thread_pointer_x18:
    mrs x18,tpidr_el0
    mov x0,x18
    ret
.size thread_pointer_x18,.-thread_pointer_x18

.p2align 2
.global thread_pointer_x18_roundtrip
.type thread_pointer_x18_roundtrip,%function
thread_pointer_x18_roundtrip:
    mrs x9,tpidr_el0
    mov x18,x0
    msr tpidr_el0,x18
    mrs x0,tpidr_el0
    msr tpidr_el0,x9
    ret
.size thread_pointer_x18_roundtrip,.-thread_pointer_x18_roundtrip
