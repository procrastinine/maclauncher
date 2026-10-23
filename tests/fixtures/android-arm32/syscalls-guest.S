.syntax unified
.arm
.text
.global raw_syscall
.type raw_syscall,%function
raw_syscall:
  push {r4-r8,lr}
  mov r7,r0
  mov r8,r2
  mov ip,r1
  ldm ip,{r0-r6}
  svc #0
  str r1,[r8]
  pop {r4-r8,pc}
.size raw_syscall,.-raw_syscall
