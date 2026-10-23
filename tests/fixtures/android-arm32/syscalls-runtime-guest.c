#include "syscall-test-numbers.h"
__attribute__((visibility("default")))
int Java_SyscallFixture_pid(void *environment,void *type){
  (void)environment;(void)type;
  register unsigned number __asm__("r7")=NR_getpid;
  register int result __asm__("r0")=0;
  __asm__ volatile("svc #0" : "+r"(result) : "r"(number) : "memory");
  return result;
}
#include <stdint.h>
uint32_t borrowed_buffer(uint32_t *value) { *value += 7;return (uint32_t)value; }
// A native finalizer commonly has no exported symbol. Preserve the Thumb bit
// and dispatch its actual address through the same invocation as named exports.
static void finish_buffer(uint32_t *value) { *value = *value * 3 + 1; }
uintptr_t buffer_finalizer(void) { return (uintptr_t)finish_buffer; }
