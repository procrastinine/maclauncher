#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include "session-core.h"

typedef struct { KLSession session; } Owner;
static Owner *active;
static int callbacks=1,unbind_ready=1,fail_initialization;
/* allocations, completed closes, physical stops, close attempts, resources, order */
static jint stats[6];
static int video(void *context){(void)context;stats[4]|=1;return 1;}
static int window(void *context,int w,int h){(void)context;(void)w;(void)h;stats[4]|=2;return 1;}
static int layer(void *context){(void)context;stats[4]|=4;return 1;}
static int drawable(void *context,int w,int h,int *out_w,int *out_h){(void)context;*out_w=w;*out_h=h;return 1;}
static int bind_display(void *context,int w,int h){(void)context;(void)w;(void)h;stats[4]|=8;return !fail_initialization;}
static int claim_producer(void *context,KLSessionBranch branch){(void)context;(void)branch;return 1;}
static int stop_display(void *context){(void)context;stats[2]++;return callbacks;}
static int unbind_display(void *context){(void)context;if(!unbind_ready)return 0;stats[4]&=~8;stats[5]=stats[5]*10+1;return 1;}
static void destroy_layer(void *context){(void)context;stats[4]&=~4;stats[5]=stats[5]*10+2;}
static void destroy_window(void *context){(void)context;stats[4]&=~2;stats[5]=stats[5]*10+3;}
static void quit_video(void *context){(void)context;stats[4]&=~1;stats[5]=stats[5]*10+4;}
static const KLSessionOps ops={video,window,layer,drawable,bind_display,claim_producer,stop_display,unbind_display,destroy_layer,destroy_window,quit_video};
static Owner *owner(jlong id){return active&&(uintptr_t)id==(uintptr_t)active?active:NULL;}
static void fail(JNIEnv *env,const char *message){jclass type=(*env)->FindClass(env,"java/lang/IllegalStateException");if(type){(*env)->ThrowNew(env,type,message);(*env)->DeleteLocalRef(env,type);}}
static jlong allocate(JNIEnv *env,jclass type){
 (void)type;if(active){fail(env,"previous native owner remains live");return 0;}
 Owner *value=calloc(1,sizeof(*value));if(!value)return 0;
 if(!kl_session_init(&value->session,&ops,value,(uintptr_t)env)){free(value);return 0;}
 active=value;stats[0]++;stats[4]=stats[5]=0;return (jlong)(uintptr_t)value;
}
static void initialize(JNIEnv *env,jclass type,jlong id,jstring title,jint w,jint h){
 (void)type;(void)title;Owner *value=owner(id);
 if(!value||!kl_session_open(&value->session,(uintptr_t)env,w,h))fail(env,"native initialization failed");
}
static jboolean stop(JNIEnv *env,jclass type,jlong id,jobject pump){
 (void)type;Owner *value=owner(id);if(!value)return JNI_FALSE;
 jclass runnable=(*env)->GetObjectClass(env,pump);if(!runnable)return JNI_FALSE;
 jmethodID run=(*env)->GetMethodID(env,runnable,"run","()V");
 if(run)(*env)->CallVoidMethod(env,pump,run);
 int pending=(*env)->ExceptionCheck(env);(*env)->DeleteLocalRef(env,runnable);
 if(pending||!run)return JNI_FALSE;
 return kl_session_stop(&value->session,(uintptr_t)env)==KL_SESSION_OK;
}
static jboolean close_session(JNIEnv *env,jclass type,jlong id){
 (void)type;Owner *value=owner(id);stats[3]++;
 if(!value||kl_session_close(&value->session,(uintptr_t)env)!=KL_SESSION_OK)return JNI_FALSE;
 free(value);active=NULL;stats[1]++;return JNI_TRUE;
}
JNIEXPORT void JNICALL Java_maclauncher_android_HostTeardownProbe_install(JNIEnv *env,jclass type){
 (void)type;jclass target=(*env)->FindClass(env,"maclauncher/android/bridge/WindowSession");if(!target)return;
 JNINativeMethod methods[]={{"allocateNative","()J",(void*)allocate},{"initializeNative","(JLjava/lang/String;II)V",(void*)initialize},{"stopNative","(JLjava/lang/Runnable;)Z",(void*)stop},{"closeNative","(J)Z",(void*)close_session}};
 (*env)->RegisterNatives(env,target,methods,4);(*env)->DeleteLocalRef(env,target);
}
JNIEXPORT void JNICALL Java_maclauncher_android_HostTeardownProbe_configure(JNIEnv *env,jclass type,jint value,jboolean unbind,jboolean initialization){(void)env;(void)type;callbacks=value;unbind_ready=unbind;fail_initialization=initialization;}
JNIEXPORT jintArray JNICALL Java_maclauncher_android_HostTeardownProbe_statistics(JNIEnv *env,jclass type){
 (void)type;jintArray result=(*env)->NewIntArray(env,6);if(result)(*env)->SetIntArrayRegion(env,result,0,6,stats);return result;
}
JNIEXPORT jboolean JNICALL Java_maclauncher_android_HostTeardownProbe_claim(JNIEnv *env,jclass type){
 (void)type;return active&&kl_session_claim(&active->session,(uintptr_t)env,KL_SESSION_NATIVE,320,240)==KL_SESSION_OK;
}
JNIEXPORT jboolean JNICALL Java_maclauncher_android_HostTeardownProbe_release(JNIEnv *env,jclass type,jboolean drained){
 (void)type;return active&&kl_session_release(&active->session,(uintptr_t)env,KL_SESSION_NATIVE,drained)==KL_SESSION_OK;
}
