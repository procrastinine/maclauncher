#include <jni.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
extern void *klj_resolve_import(const char *);
static jfieldID field(JNIEnv* e,jobject o){jclass c=(*e)->GetObjectClass(e,o);jfieldID f=(*e)->GetFieldID(e,c,"fd","I");(*e)->DeleteLocalRef(e,c);return f;}
static int fd(JNIEnv* e,jobject o){return (*e)->GetIntField(e,o,field(e,o));}
static void fail(JNIEnv* e){jclass c=(*e)->FindClass(e,"java/lang/AssertionError");(*e)->ThrowNew(e,c,"Owned pipe operation failed");(*e)->DeleteLocalRef(e,c);}
JNIEXPORT void JNICALL Java_NativeMessageQueueProbe_finishInput(JNIEnv* e,jclass unused,jlong pointer){
 (void)unused;int (*get)(void*,void**)=klj_resolve_import("AInputQueue_getEvent");void (*finish)(void*,void*,int)=klj_resolve_import("AInputQueue_finishEvent");void *event=NULL;
 if(!get||!finish||get((void*)(uintptr_t)pointer,&event)||!event){fail(e);return;}finish((void*)(uintptr_t)pointer,event,1);
}
JNIEXPORT jobjectArray JNICALL Java_NativeMessageQueueProbe_pipe(JNIEnv* e,jclass unused){(void)unused;int p[2];if(pipe(p)){fail(e);return NULL;}jclass c=(*e)->FindClass(e,"java/io/FileDescriptor");jmethodID init=(*e)->GetMethodID(e,c,"<init>","()V");jobjectArray result=(*e)->NewObjectArray(e,2,c,NULL);for(int i=0;i<2;i++){fcntl(p[i],F_SETFL,O_NONBLOCK);jobject o=(*e)->NewObject(e,c,init);(*e)->SetIntField(e,o,field(e,o),p[i]);(*e)->SetObjectArrayElement(e,result,i,o);(*e)->DeleteLocalRef(e,o);}(*e)->DeleteLocalRef(e,c);return result;}
JNIEXPORT void JNICALL Java_NativeMessageQueueProbe_write(JNIEnv* e,jclass c,jobject o){(void)c;char v=1;if(write(fd(e,o),&v,1)!=1)fail(e);}
JNIEXPORT void JNICALL Java_NativeMessageQueueProbe_read(JNIEnv* e,jclass c,jobject o){(void)c;char v=0;if(read(fd(e,o),&v,1)!=1||v!=1)fail(e);}
JNIEXPORT void JNICALL Java_NativeMessageQueueProbe_close(JNIEnv* e,jclass c,jobject o){(void)c;int n=fd(e,o);if(n>=0){(*e)->SetIntField(e,o,field(e,o),-1);if(close(n))fail(e);}}
