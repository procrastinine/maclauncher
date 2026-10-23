#include <jni.h>
#include <pthread.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <errno.h>
#include <string.h>

static JavaVM *machine;
typedef struct {size_t actual,requested;int attached,called;} Request;
static void *worker(void *opaque) {
    Request *request=opaque;
    request->actual=pthread_get_stacksize_np(pthread_self());
    JNIEnv *env=NULL;
    request->attached=(*machine)->AttachCurrentThread(machine,(void **)&env,NULL);
    if(request->attached!=JNI_OK)return NULL;
    jclass type=(*env)->FindClass(env,"java/lang/Integer");
    if(type && !(*env)->ExceptionCheck(env)) {
        jmethodID value=(*env)->GetStaticMethodID(env,type,"valueOf","(I)Ljava/lang/Integer;");
        if(value && !(*env)->ExceptionCheck(env)) {
            jobject number=(*env)->CallStaticObjectMethod(env,type,value,42);
            request->called=number && !(*env)->ExceptionCheck(env);
            if(number)(*env)->DeleteLocalRef(env,number);
        }
        (*env)->DeleteLocalRef(env,type);
    }
    if((*env)->ExceptionCheck(env))(*env)->ExceptionClear(env);
    (*machine)->DetachCurrentThread(machine);
    return NULL;
}
static void fail(JNIEnv *env,const char *message) {
    jclass type=(*env)->FindClass(env,"java/lang/AssertionError");
    if(type)(*env)->ThrowNew(env,type,message);
}
JNIEXPORT void JNICALL Java_GuestThreadStackProbe_run(JNIEnv *env,jclass owner,jstring runtime) {
    (void)owner;
    if((*env)->GetJavaVM(env,&machine)!=JNI_OK)return;
    const char *path=(*env)->GetStringUTFChars(env,runtime,NULL);
    if(!path)return;
    void *library=dlopen(path,RTLD_NOW|RTLD_LOCAL);
    (*env)->ReleaseStringUTFChars(env,runtime,path);
    if(!library){fail(env,dlerror());return;}
    int(*initialize)(void *)=dlsym(library,"klb_pthread_attr_init");
    int(*set_size)(void *,size_t)=dlsym(library,"klb_pthread_attr_setstacksize");
    int(*create)(pthread_t *,void *,void *(*)(void *),void *)=dlsym(library,"klb_pthread_create");
    int(*join)(pthread_t,void **)=dlsym(library,"klb_pthread_join");
    if(!initialize||!set_size||!create||!join){fail(env,"Guest pthread family unavailable");return;}
    pthread_attr_t native;
    size_t native_default=0;
    pthread_attr_init(&native);pthread_attr_getstacksize(&native,&native_default);pthread_attr_destroy(&native);
    const size_t sizes[]={32768,65536,98304,131072,163840,262144,1048576,1048577};
    pthread_t threads[sizeof sizes/sizeof sizes[0]];
    Request requests[sizeof sizes/sizeof sizes[0]]={0};
    size_t created=0;int error=0;
    for(size_t i=0;i<sizeof sizes/sizeof sizes[0];i++) {
        // The runtime owns the bionic attribute layout; only its API writes it.
        uint64_t attribute[16]={0};
        initialize(attribute);set_size(attribute,sizes[i]);
        requests[i].requested=sizes[i];requests[i].attached=JNI_ERR;
        error=create(&threads[i],attribute,worker,&requests[i]);
        if(error)break;
        created++;
    }
    for(size_t i=0;i<created;i++)if(join(threads[i],NULL))error=1;
    if(error){fail(env,"Guest native thread could not start or retire");return;}
    for(size_t i=0;i<created;i++) {
        Request *request=&requests[i];
        if(request->attached!=JNI_OK||!request->called||request->actual<native_default||request->actual<request->requested) {
            char message[256];snprintf(message,sizeof message,"requested=%zu actual=%zu attach=%d Java call=%d",request->requested,request->actual,request->attached,request->called);
            fail(env,message);return;
        }
    }
    uint64_t invalid[16]={0};initialize(invalid);set_size(invalid,SIZE_MAX);
    pthread_t unused;
    if(create(&unused,invalid,worker,&requests[0])!=EINVAL)fail(env,"Overflowing stack reserve must fail before starting a thread");
}
