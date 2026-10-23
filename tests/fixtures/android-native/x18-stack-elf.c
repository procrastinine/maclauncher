#include <jni.h>
#include <stdint.h>
#include <string.h>

extern uintptr_t simd_stack_elf(uint8_t *,int64_t,uint64_t *);
extern uintptr_t alu_stack_elf(uint8_t *,uintptr_t,uint64_t *);
static _Alignas(16) uint8_t storage[65536];
JNIEXPORT jint JNICALL Java_StackSimdProbe_execute(JNIEnv *environment,jclass type) {
    (void)environment;(void)type;const int deltas[]={-8192,-16,16,8192};
    for(unsigned i=0;i<4;i++) {
        uint8_t *base=storage+32768;uint64_t values[4]={0};memset(base,0,16);
        uintptr_t sp=simd_stack_elf(base,deltas[i],values);
        if(sp!=(uintptr_t)base+deltas[i] || values[0]!=0x1616 || values[1]!=0x1717 ||
           values[2]!=0x60000000u || values[3]!=values[2] ||
           base[0]!=0x31 || base[1]!=0x40 || base[2]!=0x41 || base[3]!=0x42)return -1;
        memset(values,0,sizeof values);
        sp=alu_stack_elf(base,(uintptr_t)base+deltas[i]+186,values);
        if(sp!=(uintptr_t)base+deltas[i] || values[0]!=0x1616 || values[1]!=0x1717 ||
           values[2]!=0x60000000u || values[3]!=values[2])return -2;
    }
    return 4;
}
