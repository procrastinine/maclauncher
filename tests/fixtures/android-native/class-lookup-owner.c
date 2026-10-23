#include <jni.h>
#include <jvmti.h>
#include <pthread.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
extern int klj_class_lookup_prepare(JNIEnv *,jniNativeInterface *);
extern int klj_class_lookup_bind(JNIEnv *,void *,void *,jclass);
typedef jclass (*Find)(JNIEnv *,const char *);
static JavaVM *vm;static void *runtime;static Find guests[3];
void *kl_base(void *image){return image;}
size_t kl_span(void *image){(void)image;return 128;}
static void fail(JNIEnv *env,const char *message){jclass type=(*env)->FindClass(env,"java/lang/AssertionError");if(type)(*env)->ThrowNew(env,type,message);}
JNIEXPORT void JNICALL Java_ClassLookupProbe_setup(JNIEnv *env,jclass cls,jstring self,jobjectArray libraries,jclass a,jclass b){
    (void)cls;(*env)->GetJavaVM(env,&vm);
    const char *path=(*env)->GetStringUTFChars(env,self,NULL);runtime=dlopen(path,RTLD_NOW|RTLD_LOCAL);(*env)->ReleaseStringUTFChars(env,self,path);
    if(!runtime){fail(env,dlerror());return;}
    for(int i=0;i<3;i++){
        jstring file=(*env)->GetObjectArrayElement(env,libraries,i);const char *name=(*env)->GetStringUTFChars(env,file,NULL);
        void *library=dlopen(name,RTLD_NOW|RTLD_LOCAL);(*env)->ReleaseStringUTFChars(env,file,name);(*env)->DeleteLocalRef(env,file);
        guests[i]=library?dlsym(library,"guest_find"):NULL;if(!guests[i]){fail(env,"guest fixture missing");return;}
    }
    jvmtiEnv *ti=NULL;jniNativeInterface *table=NULL;
    if((*vm)->GetEnv(vm,(void **)&ti,JVMTI_VERSION_1_2)!=JNI_OK||(*ti)->GetJNIFunctionTable(ti,&table)!=JVMTI_ERROR_NONE){fail(env,"JNI table unavailable");return;}
    int okay=klj_class_lookup_prepare(env,table)&&(*ti)->SetJNIFunctionTable(ti,table)==JVMTI_ERROR_NONE;
    (*ti)->Deallocate(ti,(unsigned char *)table);
    if(!okay||!klj_class_lookup_bind(env,runtime,(void *)guests[0],a)||!klj_class_lookup_bind(env,runtime,(void *)guests[1],b)){fail(env,"class owner not bound");return;}
}
typedef struct {int guest,pending;const char *name;jobject found;jthrowable failure;} Request;
static void *worker(void *opaque){
    Request *request=opaque;JNIEnv *env=NULL;
    if((*vm)->AttachCurrentThread(vm,(void **)&env,NULL)!=JNI_OK)abort();
    if(request->pending){jclass type=(*env)->FindClass(env,"java/lang/IllegalStateException");(*env)->ThrowNew(env,type,"original-pending");(*env)->DeleteLocalRef(env,type);}
    jclass result=guests[request->guest](env,request->name);
    if((*env)->ExceptionCheck(env)){jthrowable failure=(*env)->ExceptionOccurred(env);(*env)->ExceptionClear(env);request->failure=(*env)->NewGlobalRef(env,failure);(*env)->DeleteLocalRef(env,failure);}
    else if(result)request->found=(*env)->NewGlobalRef(env,result);
    if(result)(*env)->DeleteLocalRef(env,result);
    (*vm)->DetachCurrentThread(vm);return NULL;
}
JNIEXPORT jclass JNICALL Java_ClassLookupProbe_lookup(JNIEnv *env,jclass cls,jint guest,jstring name,jboolean pending){
    (void)cls;const char *text=(*env)->GetStringUTFChars(env,name,NULL);Request request={.guest=guest,.pending=pending,.name=text};
    pthread_t thread;if(pthread_create(&thread,NULL,worker,&request))abort();pthread_join(thread,NULL);(*env)->ReleaseStringUTFChars(env,name,text);
    if(request.failure){(*env)->Throw(env,request.failure);(*env)->DeleteGlobalRef(env,request.failure);return NULL;}
    jclass result=(*env)->NewLocalRef(env,request.found);if(request.found)(*env)->DeleteGlobalRef(env,request.found);return result;
}
JNIEXPORT void JNICALL Java_ClassLookupProbe_share(JNIEnv *env,jclass cls,jclass b){(void)cls;if(!klj_class_lookup_bind(env,runtime,(void *)guests[0],b))fail(env,"second owner registration failed");}
JNIEXPORT void JNICALL Java_ClassLookupProbe_activeUse(JNIEnv *env,jclass cls,jclass target){(void)cls;(*env)->GetMethodID(env,target,"<init>","()V");}
JNIEXPORT jclass JNICALL Java_ClassLookupProbe_hostLookup(JNIEnv *env,jclass cls,jstring name){(void)cls;const char *text=(*env)->GetStringUTFChars(env,name,NULL);if(!text)return NULL;jclass result=(*env)->FindClass(env,text);(*env)->ReleaseStringUTFChars(env,name,text);return result;}
JNIEXPORT void JNICALL Java_ClassLookupProbe_descriptors(JNIEnv *env,jclass cls,jobject descriptor,jclass unrelated){
    (void)cls;jclass type=(*env)->GetObjectClass(env,descriptor);
    jfieldID android=(*env)->GetFieldID(env,type,"descriptor","I");if(!android)return;
    jfieldID host=(*env)->GetFieldID(env,type,"fd","I");if(!host)return;
    if(android!=host){fail(env,"Descriptor alias does not share VM storage");return;}
    int fd=(*env)->GetIntField(env,descriptor,android);
    if(fd<0||fcntl(fd,F_GETFD)<0||write(fd,"A",1)!=1){fail(env,"Descriptor alias is not the actual open file");return;}
    (*env)->SetIntField(env,descriptor,android,-1);
    if((*env)->GetIntField(env,descriptor,host)!=-1){fail(env,"Descriptor writes diverged");return;}
    (*env)->SetIntField(env,descriptor,android,fd);
    jfieldID other=(*env)->GetFieldID(env,unrelated,"descriptor","I");if(!other)return;
    for(int wrong=0;wrong<2;wrong++){
        (void)(*env)->GetFieldID(env,wrong?cls:type,"descriptor",wrong?"I":"J");
        if(!(*env)->ExceptionCheck(env)){fail(env,"Unrelated descriptor class or signature unexpectedly resolved");return;}
        jthrowable error=(*env)->ExceptionOccurred(env);(*env)->ExceptionClear(env);
        jclass missing=(*env)->FindClass(env,"java/lang/NoSuchFieldError");
        if(missing&&!(*env)->IsInstanceOf(env,error,missing))fail(env,"Wrong descriptor lookup changed failure");
        if(missing)(*env)->DeleteLocalRef(env,missing);(*env)->DeleteLocalRef(env,error);
        if((*env)->ExceptionCheck(env))return;
    }
    (*env)->DeleteLocalRef(env,type);
}
