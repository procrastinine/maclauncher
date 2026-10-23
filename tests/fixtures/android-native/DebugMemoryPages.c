#include <jni.h>
#include <mach/mach.h>
#include <mach/mach_vm.h>
#include <mach/vm_statistics.h>
#include <stdint.h>
JNIEXPORT jlong JNICALL Java_maclauncher_android_fixture_DebugMemoryProbe_allocate(JNIEnv *env,jclass type,jlong length){
    (void)env;(void)type;mach_vm_address_t address=0;
    if(mach_vm_allocate(mach_task_self(),&address,length,VM_FLAGS_ANYWHERE|VM_MAKE_TAG(VM_MEMORY_MALLOC_LARGE))!=KERN_SUCCESS)return 0;
    volatile unsigned char *bytes=(volatile unsigned char *)(uintptr_t)address;
    for(uint64_t offset=0;offset<(uint64_t)length;offset+=vm_page_size)bytes[offset]=(unsigned char)(offset/vm_page_size+1);
    return address;
}
JNIEXPORT void JNICALL Java_maclauncher_android_fixture_DebugMemoryProbe_release(JNIEnv *env,jclass type,jlong address,jlong length){(void)env;(void)type;mach_vm_deallocate(mach_task_self(),address,length);}
