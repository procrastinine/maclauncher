#include "host-callbacks.h"
#include <stdint.h>
JNIEXPORT jlong JNICALL Java_callbacks_CallbackOwner_createBindings(JNIEnv*env,jclass owner){return (jlong)(uintptr_t)kl_host_callbacks_create(env);}
JNIEXPORT jlong JNICALL Java_callbacks_CallbackOwner_retainBindings(JNIEnv*env,jclass owner,jlong handle){return (jlong)(uintptr_t)kl_host_callbacks_retain((KLHostCallbacks*)(uintptr_t)handle);}
JNIEXPORT void JNICALL Java_callbacks_CallbackOwner_releaseBindings(JNIEnv*env,jclass owner,jlong handle){kl_host_callbacks_release(env,(KLHostCallbacks*)(uintptr_t)handle);}
JNIEXPORT void JNICALL Java_callbacks_CallbackOwner_exercise(JNIEnv*env,jobject object,jlong handle){
 KLHostCallbacks *callbacks=(KLHostCallbacks*)(uintptr_t)handle;
 KLHost_callbacks_CallbackOwner made=kl_host_owner_create(env,callbacks,7);
 if((*env)->ExceptionCheck(env))return;
 jint value=kl_host_value(env,callbacks,made);(*env)->DeleteLocalRef(env,made.object);
 if(value!=7||(*env)->ExceptionCheck(env))goto failed;
 KLHost_callbacks_CallbackOwner owner=kl_host_bind_KLHost_callbacks_CallbackOwner(env,callbacks,object);
 kl_host_capture(env,callbacks,owner,42);
 if((*env)->ExceptionCheck(env))goto done;
 if(kl_host_value(env,callbacks,owner)!=42||(*env)->ExceptionCheck(env))goto failed;
 // Cleanup uses exactly the same typed invocation as normal dispatch.
 kl_host_capture(env,callbacks,owner,0);
 if((*env)->ExceptionCheck(env))goto done;
 if(kl_host_value(env,callbacks,owner)!=0||(*env)->ExceptionCheck(env))goto failed;
 goto done;
failed:;
 if(!(*env)->ExceptionCheck(env)){jclass type=(*env)->FindClass(env,"java/lang/AssertionError");if(type)(*env)->ThrowNew(env,type,"Callback did not change receiver state");}
done:
 return;
}
