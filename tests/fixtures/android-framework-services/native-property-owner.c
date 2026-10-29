#include <jni.h>
#include <assert.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// The fixture owns immutable records exactly as Klepton owns prop_info. The
// production bridge must pass these pointers through without another registry.
static char records[512][32];
static const void *find_property(const char *name){
    if(strncmp(name,"fixture.",8))return NULL;
    char *end;unsigned long index=strtoul(name+8,&end,10);if(*end||index>=512)return NULL;
    return records[index];
}
static int get_property(const char *name,char *value){
    const void *property=find_property(name);if(!property){*value=0;return 0;}
    unsigned index=((uintptr_t)property-(uintptr_t)records)/sizeof records[0];
    return snprintf(value,92,"%u",index+1000);
}
static void read_property(const void *property,char *name,char *value){
    uintptr_t offset=(uintptr_t)property-(uintptr_t)records;assert(offset<sizeof records&&offset%sizeof records[0]==0);
    if(name)snprintf(name,32,"%s",(const char*)property);
    get_property(property,value);
}
static int set_property(const char *name,const char *value){
    assert(!strcmp(name,"dalvik.vm.heapsize")||!strcmp(name,"dalvik.vm.heapgrowthlimit"));
    char *end;long mib=strtol(value,&end,10);assert(mib>0&&!strcmp(end,"m"));return 0;
}
void *kl_shim_lookup(const char *name){
    if(!strcmp(name,"__system_property_find"))return (void*)find_property;
    if(!strcmp(name,"__system_property_get"))return (void*)get_property;
    if(!strcmp(name,"__system_property_read"))return (void*)read_property;
    if(!strcmp(name,"__system_property_set"))return (void*)set_property;
    return NULL;
}
// The JNI loader owns one process-lifetime JVMTI environment; the fixture
// supplies that environment directly to the property bridge.
#include <jvmti.h>
jvmtiEnv *klj_jni_vm_tooling(JNIEnv *env){
    static jvmtiEnv *tooling;JavaVM *vm=NULL;
    if(!tooling&&((*env)->GetJavaVM(env,&vm)!=JNI_OK||(*vm)->GetEnv(vm,(void**)&tooling,JVMTI_VERSION_1_2)!=JNI_OK))return NULL;
    return tooling;
}
#define JNI_OnLoad property_bridge_on_load
#include ANDROID_PROPERTY_SOURCE
#undef JNI_OnLoad
JNIEXPORT jlong JNICALL Java_NativePropertyOwnerProbe_find(JNIEnv *env,jclass type,jstring key){return Java_android_os_SystemProperties_native_1find(env,type,key);}
JNIEXPORT jint JNICALL Java_NativePropertyOwnerProbe_read(JNIEnv *env,jclass type,jlong handle){return Java_android_os_SystemProperties_native_1get_1int__JI(env,type,handle,-1);}
JNIEXPORT jboolean JNICALL Java_NativePropertyOwnerProbe_sameOwner(JNIEnv *env,jclass type,jlong handle,jint index){(void)env;(void)type;return (uintptr_t)handle==(uintptr_t)records[index];}
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm,void *reserved){for(unsigned i=0;i<512;++i)snprintf(records[i],sizeof records[i],"fixture.%u",i);return property_bridge_on_load(vm,reserved);}
