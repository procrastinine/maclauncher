.syntax unified
.text
.arm
.global arm_add
.type arm_add,%function
arm_add:
  add r0,r0,r1
  bx lr
.global read_tls
.type read_tls,%function
read_tls:
  mrc p15,0,r0,c13,c0,3
  bx lr
.global svc_thread
.type svc_thread,%function
svc_thread:
  push {r7,lr}
  mov r7,#224
  svc #0
  pop {r7,pc}
