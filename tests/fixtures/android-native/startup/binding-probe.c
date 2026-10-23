#include <jni.h>
#include <dlfcn.h>
#include <string.h>
typedef struct {int argc;char **argv;char **envp;} Startup;
JNIEXPORT jboolean JNICALL Java_maclauncher_android_bridge_StartupBindingProbe_inspect(JNIEnv *env,jclass type,jstring path){
    (void)type;const char *file=(*env)->GetStringUTFChars(env,path,NULL);if(!file)return JNI_FALSE;
    void *core=dlopen(file,RTLD_NOW|RTLD_NOLOAD);(*env)->ReleaseStringUTFChars(env,path,file);if(!core)return JNI_FALSE;
    const Startup *(*get)(void)=dlsym(core,"klj_library_startup");const Startup *value=get?get():NULL;
    int good=value&&value->argc==1&&!strcmp(value->argv[0],"startup.owner:worker")&&!value->argv[1]&&
        value->envp[0]&&!strcmp(value->envp[0],"HOME=/guest/\xc3\xa9\xf0\x9f\x8e\xae\n=value")&&
        value->envp[1]&&!strcmp(value->envp[1],"EMPTY=")&&!value->envp[2];
    dlclose(core);return good?JNI_TRUE:JNI_FALSE;
}
