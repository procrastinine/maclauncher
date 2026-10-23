#include "probe.h"
static int constructor_detached;
__attribute__((constructor))static void initialize(void){
 JavaVM *vm=aaudio_original_probe_vm();void *env=(void*)1;
 constructor_detached=vm&&(*vm)->GetEnv(vm,&env,JNI_VERSION_1_6)==JNI_EDETACHED&&!env;
}
int aaudio_original_plugin_value(void){return 73;}
int aaudio_original_plugin_constructor_detached(void){return constructor_detached;}
