.text
.p2align 2
.globl _guest_calls_start
_guest_calls_start:
.globl _guest_protected_attach
_guest_protected_attach:
 // The same TPIDRRO+40 guard used by ARM64 Android stack protection. The
 // protected frame is active across the actual guest JavaVM Attach call.
 sub sp,sp,#32
 stp x29,x30,[sp,#16]
 mrs x9,tpidrro_el0
 ldr x10,[x9,#40]
 str x10,[sp]
 ldr x8,[x0]
 ldr x8,[x8,#56]
 mov x2,xzr
 blr x8
 mrs x9,tpidrro_el0
 ldr x10,[x9,#40]
 ldr x11,[sp]
 cmp x10,x11
 b.eq Lprotected_attach_done
 mov w0,#-99
Lprotected_attach_done:
 ldp x29,x30,[sp,#16]
 add sp,sp,#32
 ret
.globl _guest_scalar
_guest_scalar:
 sub sp,sp,#32
 stp x19,x30,[sp,#16]
 str xzr,[sp,#0]
 mov x19,x0
 mov x0,x1
 mov x1,x2
 mov x2,x3
 mov x3,#123
 blr x19
 ldp x19,x30,[sp,#16]
 add sp,sp,#32
 ret
.globl _guest_mixed
_guest_mixed:
 sub sp,sp,#512
 stp x19,x30,[sp,#480]
 mov x19,x0
 str w5,[sp,#472]
 mov x0,x1
 mov x1,x2
 mov x2,x3
 mov x3,#7
 movz x5,#0x5566
 movk x5,#0x3344,lsl#16
 movk x5,#0x1122,lsl#32
 mov x6,#-17
 mov x7,#23
 fmov d0,#3.5
 fmov d1,#1.25
 fmov d2,#2.5
 fmov d3,#4.5
 fmov d4,#6.5
 fmov d5,#8.5
 fmov d6,#10.5
 fmov d7,#12.5
 mov x9,#31
 str x9,[sp,#0]
 mov x9,#47
 str x9,[sp,#8]
 str x4,[sp,#16]
 fmov d16,#14.5
 str d16,[sp,#24]
 ldr w9,[sp,#472]
 cbz w9,Lmixed_call
 cmp w9,#2
 b.eq Lmixed_array
 stp x0,x1,[sp,#64]
 stp x2,x3,[sp,#80]
 stp x4,x5,[sp,#96]
 stp x6,x7,[sp,#112]
 stp q0,q1,[sp,#128]
 stp q2,q3,[sp,#160]
 stp q4,q5,[sp,#192]
 stp q6,q7,[sp,#224]
 mov x9,sp
 str x9,[sp,#256]
 add x9,sp,#128
 str x9,[sp,#264]
 add x9,sp,#256
 str x9,[sp,#272]
 mov w9,#-40
 str w9,[sp,#280]
 mov w9,#-128
 str w9,[sp,#284]
 add x3,sp,#256
 b Lmixed_call
Lmixed_array:
 str x3,[sp,#320]
 str x4,[sp,#328]
 str x5,[sp,#336]
 str d0,[sp,#344]
 fmov s16,#1.25
 str s16,[sp,#352]
 str x6,[sp,#360]
 str x7,[sp,#368]
 mov x9,#31
 str x9,[sp,#376]
 mov x9,#47
 str x9,[sp,#384]
 str x4,[sp,#392]
 str d2,[sp,#400]
 str d3,[sp,#408]
 str d4,[sp,#416]
 str d5,[sp,#424]
 str d6,[sp,#432]
 str d7,[sp,#440]
 fmov d16,#14.5
 str d16,[sp,#448]
 add x3,sp,#320
Lmixed_call:
 blr x19
 ldp x19,x30,[sp,#480]
 add sp,sp,#512
 ret
// One promoted integer for every return family and constructor, in ordinary,
// nonvirtual and va_list/array forms. Return raw x0 and d0 to the C assertion.
.globl _guest_one
_guest_one:
 sub sp,sp,#256
 stp x19,x30,[sp,#224]
 mov x19,x0
 mov x0,x1
 mov x1,x2
 mov x9,x3
 cmp w7,#4
 b.eq Lone_nonvirtual
 mov x2,x9
 mov x3,x6
 b Lone_form
Lone_nonvirtual:
 mov x2,x4
 mov x3,x9
 mov x4,x6
Lone_form:
 cbz w5,Lone_call
 cmp w5,#2
 b.eq Lone_array
 stp x0,x1,[sp,#64]
 stp x2,x3,[sp,#80]
 stp x4,x5,[sp,#96]
 stp x6,x7,[sp,#112]
 mov x9,sp
 str x9,[sp,#128]
 add x9,sp,#128
 str x9,[sp,#136]
 str xzr,[sp,#144]
 mov w9,#-40
 cmp w7,#4
 b.ne Lone_voffset
 mov w9,#-32
Lone_voffset:
 str w9,[sp,#152]
 str wzr,[sp,#156]
 add x9,sp,#128
 cmp w5,#3
 b.ne Lone_pointer
 str x6,[sp]
 mov w10,#8
 str w10,[sp,#152]
 mov w10,#16
 str w10,[sp,#156]
 b Lone_pointer
Lone_array:
 str x6,[sp]
 mov x9,sp
Lone_pointer:
 cmp w7,#4
 b.eq Lone_pointer4
 mov x3,x9
 b Lone_call
Lone_pointer4:
 mov x4,x9
Lone_call:
 blr x19
 fmov x1,d0
 ldp x19,x30,[sp,#224]
 add sp,sp,#256
 ret
.globl _guest_calls_end
_guest_calls_end:
