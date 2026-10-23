#include <jni.h>
#include <stdarg.h>
#ifdef NATIVE_BRIDGE_DEPENDENCIES
#include <string.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <pthread.h>
#include <stdio.h>
#include <errno.h>
#include <semaphore.h>
#include <unistd.h>
#include <SLES/OpenSLES.h>
#include <SLES/OpenSLES_Android.h>
#include <android/asset_manager_jni.h>
extern int group_value(void),peer_value(void);
extern const short *_tolower_tab_,*_toupper_tab_;
extern void *original_new_array(unsigned) __asm__("_Znaj");
extern void original_delete_array(void *) __asm__("_ZdaPv");
static unsigned once_calls;
JNIEXPORT jlong JNICALL Java_ArtSharedJniProbe_asset(JNIEnv *env,jclass type,jobject manager,jstring name,jlong size){
 (void)type;AAssetManager *owner=AAssetManager_fromJava(env,manager);
 const char *path=(*env)->GetStringUTFChars(env,name,0);
 AAsset *file=AAssetManager_open(owner,path,AASSET_MODE_STREAMING);
 (*env)->ReleaseStringUTFChars(env,name,path);
 if(!file)return -1;
 if(AAsset_getLength(file)!=size||AAsset_getLength64(file)!=size){AAsset_close(file);return -2;}
 unsigned hash=2166136261u;unsigned char bytes[4096];long long total=0;int count;
 while((count=AAsset_read(file,bytes,sizeof bytes))>0){for(int i=0;i<count;i++)hash=(hash^bytes[i])*16777619u;total+=count;}
 if(count<0||total!=size||AAsset_getRemainingLength64(file)!=0){AAsset_close(file);return -3;}
 if(AAsset_seek(file,0,SEEK_SET)!=0||AAsset_getRemainingLength(file)!=size){AAsset_close(file);return -4;}
 AAsset_close(file);return hash;
}
static int local_interfaces(void){
 SLObjectItf object=0;SLEngineItf engine=0,copy=0;SLuint32 count=0;
 if(slCreateEngine(&object,0,0,0,0,0)!=SL_RESULT_SUCCESS)return 0;
 if((*object)->GetInterface(object,SL_IID_ENGINE,&engine)!=SL_RESULT_SUCCESS)return 0;
 struct SLInterfaceID_ copied=*SL_IID_ENGINE;
 if((*object)->GetInterface(object,&copied,&copy)!=SL_RESULT_SUCCESS||copy!=engine)return 0;
 if((*engine)->QueryNumSupportedInterfaces(engine,0,&count)!=SL_RESULT_SUCCESS||(count!=1&&count!=2))return 0;
 SLObjectItf mix=0,player=0;
 if((*engine)->CreateOutputMix(engine,&mix,0,0,0)!=SL_RESULT_SUCCESS||mix!=object)return 0;
 SLDataLocator_OutputMix output={SL_DATALOCATOR_OUTPUTMIX,mix};SLDataSink sink={&output,0};
 SLDataLocator_AndroidSimpleBufferQueue queue={SL_DATALOCATOR_ANDROIDSIMPLEBUFFERQUEUE,2};
 SLAndroidDataFormat_PCM_EX pcm={SL_ANDROID_DATAFORMAT_PCM_EX,2,44100000,32,32,SL_SPEAKER_FRONT_LEFT|SL_SPEAKER_FRONT_RIGHT,SL_BYTEORDER_LITTLEENDIAN,SL_ANDROID_PCM_REPRESENTATION_FLOAT};
 SLDataSource source={&queue,&pcm};
 if((*engine)->CreateAudioPlayer(engine,&player,&source,&sink,0,0,0)!=SL_RESULT_SUCCESS||player!=object)return 0;
 SLDataLocator_URI uri={SL_DATALOCATOR_URI,(SLchar *)"fixture://original"};
 SLDataFormat_MIME mime={SL_DATAFORMAT_MIME,(SLchar *)"audio/test",SL_CONTAINERTYPE_UNSPECIFIED};
 source.pLocator=&uri;source.pFormat=&mime;
 if((*engine)->CreateAudioPlayer(engine,&player,&source,&sink,0,0,0)!=SL_RESULT_SUCCESS||uri.URI!=(SLchar *)"fixture://original")return 0;
 SLDataLocator_AndroidFD fd={SL_DATALOCATOR_ANDROIDFD,7,0x100000003LL,0x200000005LL};
 source.pLocator=&fd;source.pFormat=0;
 if((*engine)->CreateAudioPlayer(engine,&player,&source,&sink,0,0,0)!=SL_RESULT_SUCCESS||fd.offset!=0x100000003LL||output.outputMix!=mix)return 0;
 fprintf(stderr,"PASS original tagged OpenSL locator/format and retained object identity owner=%u\n",count);
 void *unsupported=(void *)1;
 if((*object)->GetInterface(object,SL_IID_VOLUME,&unsupported)!=SL_RESULT_FEATURE_UNSUPPORTED||unsupported)return 0;
 (*object)->Destroy(object);
 fprintf(stderr,"PASS local original OpenSL interface owner=%u\n",count);return 1;
}
static void once_body(void){++once_calls;}
static int synchronization_family(void){
 struct {
  pthread_mutex_t mutex;unsigned char mutex_guard[64];
  pthread_cond_t cond;unsigned char cond_guard[64];
  pthread_rwlock_t rwlock;unsigned char rwlock_guard[64];
  pthread_barrier_t barrier;unsigned char barrier_guard[64];
  pthread_spinlock_t spin;unsigned char spin_guard[64];
  sem_t semaphore;unsigned char semaphore_guard[64];
 } state;
 memset(&state,0x63,sizeof state);
#define CHECK_SYNC(expression) do {if(!(expression)){fprintf(stderr,"ARM32 synchronization failed: %s\n",#expression);return 0;}}while(0)
#define CHECK_GUARD(member) do {for(unsigned i=0;i<sizeof state.member##_guard;i++)CHECK_SYNC(state.member##_guard[i]==0x63);}while(0)
 CHECK_SYNC(pthread_mutex_init(&state.mutex,0)==0);CHECK_GUARD(mutex);
 CHECK_SYNC(pthread_mutex_lock(&state.mutex)==0&&pthread_mutex_unlock(&state.mutex)==0);
 // A contended original mutex enters Bionic's scoped trace, exercising the
 // helper image's actual native provider dependencies as well as its fast path.
 CHECK_SYNC(pthread_mutex_lock(&state.mutex)==0);
 struct timespec limit;CHECK_SYNC(clock_gettime(CLOCK_REALTIME,&limit)==0);
 limit.tv_nsec+=20000000;if(limit.tv_nsec>=1000000000){++limit.tv_sec;limit.tv_nsec-=1000000000;}
 CHECK_SYNC(pthread_mutex_timedlock(&state.mutex,&limit)==ETIMEDOUT);
 CHECK_SYNC(pthread_mutex_unlock(&state.mutex)==0);
 CHECK_SYNC(pthread_cond_init(&state.cond,0)==0);CHECK_GUARD(cond);
 CHECK_SYNC(pthread_mutex_lock(&state.mutex)==0);
 const struct timespec expired={0,0};
 CHECK_SYNC(pthread_cond_timedwait(&state.cond,&state.mutex,&expired)==ETIMEDOUT);
 CHECK_SYNC(pthread_mutex_unlock(&state.mutex)==0);
 CHECK_SYNC(pthread_cond_signal(&state.cond)==0&&pthread_cond_broadcast(&state.cond)==0);
 CHECK_SYNC(pthread_cond_destroy(&state.cond)==0&&pthread_mutex_destroy(&state.mutex)==0);
 // Recursive owner state is the original 16-bit Linux TID, never a truncated
 // Darwin thread token or an independent mutex-side identity.
 CHECK_SYNC(gettid()>0&&gettid()<=65535);
 fprintf(stderr,"ORIGINAL_IDENTITY pid=%d tid=%d\n",getpid(),gettid());
 pthread_mutex_t recursive=PTHREAD_RECURSIVE_MUTEX_INITIALIZER_NP;
 CHECK_SYNC(pthread_mutex_lock(&recursive)==0&&pthread_mutex_trylock(&recursive)==0);
 CHECK_SYNC(pthread_mutex_unlock(&recursive)==0&&pthread_mutex_unlock(&recursive)==0);
 CHECK_SYNC(pthread_mutex_destroy(&recursive)==0);
 pthread_mutexattr_t attributes;CHECK_SYNC(pthread_mutexattr_init(&attributes)==0);
 CHECK_SYNC(pthread_mutexattr_settype(&attributes,PTHREAD_MUTEX_ERRORCHECK)==0);
 CHECK_SYNC(pthread_mutexattr_setpshared(&attributes,PTHREAD_PROCESS_SHARED)==0);
 CHECK_SYNC(pthread_mutex_init(&state.mutex,&attributes)==0);
 CHECK_SYNC(pthread_mutex_lock(&state.mutex)==0&&pthread_mutex_lock(&state.mutex)==EDEADLK);
 CHECK_SYNC(pthread_mutex_unlock(&state.mutex)==0&&pthread_mutex_unlock(&state.mutex)==EPERM);
 CHECK_SYNC(pthread_mutex_destroy(&state.mutex)==0);
 CHECK_SYNC(pthread_mutexattr_setpshared(&attributes,PTHREAD_PROCESS_PRIVATE)==0);
 CHECK_SYNC(pthread_mutexattr_setprotocol(&attributes,PTHREAD_PRIO_INHERIT)==0);
 CHECK_SYNC(pthread_mutex_init(&state.mutex,&attributes)==0);
 CHECK_SYNC(pthread_mutex_lock(&state.mutex)==0&&pthread_mutex_lock(&state.mutex)==EDEADLK);
 CHECK_SYNC(pthread_mutex_unlock(&state.mutex)==0&&pthread_mutex_destroy(&state.mutex)==0);
 CHECK_SYNC(pthread_mutexattr_destroy(&attributes)==0);CHECK_GUARD(mutex);
 CHECK_SYNC(pthread_rwlock_init(&state.rwlock,0)==0);CHECK_GUARD(rwlock);
 CHECK_SYNC(pthread_rwlock_rdlock(&state.rwlock)==0&&pthread_rwlock_trywrlock(&state.rwlock)==EBUSY);
 CHECK_SYNC(pthread_rwlock_unlock(&state.rwlock)==0&&pthread_rwlock_wrlock(&state.rwlock)==0);
 CHECK_SYNC(pthread_rwlock_rdlock(&state.rwlock)==EDEADLK);
 CHECK_SYNC(pthread_rwlock_unlock(&state.rwlock)==0&&pthread_rwlock_destroy(&state.rwlock)==0);
 CHECK_SYNC(pthread_barrier_init(&state.barrier,0,1)==0);CHECK_GUARD(barrier);
 CHECK_SYNC(pthread_barrier_wait(&state.barrier)==PTHREAD_BARRIER_SERIAL_THREAD);
 CHECK_SYNC(pthread_barrier_destroy(&state.barrier)==0);
 CHECK_SYNC(pthread_spin_init(&state.spin,PTHREAD_PROCESS_PRIVATE)==0);CHECK_GUARD(spin);
 CHECK_SYNC(pthread_spin_lock(&state.spin)==0&&pthread_spin_trylock(&state.spin)==EBUSY);
 CHECK_SYNC(pthread_spin_unlock(&state.spin)==0&&pthread_spin_destroy(&state.spin)==0);
 pthread_once_t once=PTHREAD_ONCE_INIT;
 CHECK_SYNC(pthread_once(&once,once_body)==0&&pthread_once(&once,once_body)==0&&once_calls==1);
 CHECK_SYNC(sem_init(&state.semaphore,1,1)==0);CHECK_GUARD(semaphore);
 CHECK_SYNC(sem_wait(&state.semaphore)==0&&sem_trywait(&state.semaphore)==-1&&errno==EAGAIN);
 CHECK_SYNC(sem_timedwait(&state.semaphore,&expired)==-1&&errno==ETIMEDOUT);
 CHECK_SYNC(sem_post(&state.semaphore)==0&&sem_destroy(&state.semaphore)==0);
 CHECK_GUARD(mutex);CHECK_GUARD(cond);CHECK_GUARD(rwlock);CHECK_GUARD(barrier);CHECK_GUARD(spin);CHECK_GUARD(semaphore);
#undef CHECK_GUARD
#undef CHECK_SYNC
 return 1;
}
#endif
static jlong through_v(JNIEnv *env,jclass type,jmethodID method,...) {
 va_list args;va_start(args,method);
 jlong result=(*env)->CallStaticLongMethodV(env,type,method,args);
 va_end(args);return result;
}
static jlong roundtrip(JNIEnv *env,jclass type,jbyte narrow,jshort signed16,
 jlong value,jfloat single,jdouble wide,jstring text,jintArray array) {
 if(narrow!=-91||signed16!=-12345||single!=1.25f||wide!=3.5)return -1;
 jobject retained=(*env)->NewGlobalRef(env,text);
 jweak weak=(*env)->NewWeakGlobalRef(env,retained);
 if(!(*env)->IsSameObject(env,retained,weak))return -2;
 jint *values=(*env)->GetPrimitiveArrayCritical(env,array,0);
 if(!values)return -3;
 values[0]+=7;
 (*env)->ReleasePrimitiveArrayCritical(env,array,values,0);
 const char *chars=(*env)->GetStringUTFChars(env,text,0);
 if(!chars||chars[0]!='a')return -4;
 (*env)->ReleaseStringUTFChars(env,text,chars);
 jmethodID callback=(*env)->GetStaticMethodID(env,type,"callback","(JFDLjava/lang/String;[I)J");
 if(!callback)return -5;
 jlong result=(*env)->CallStaticLongMethod(env,type,callback,value,1.25,3.5,text,array);
 if(!(*env)->ExceptionCheck(env)){
  jlong other=through_v(env,type,callback,value,1.25,3.5,text,array);
  if(other!=result)return -6;
  jvalue arguments[5];arguments[0].j=value;arguments[1].f=single;arguments[2].d=wide;arguments[3].l=text;arguments[4].l=array;
  if((*env)->CallStaticLongMethodA(env,type,callback,arguments)!=result)return -7;
 }
 (*env)->DeleteWeakGlobalRef(env,weak);
 (*env)->DeleteGlobalRef(env,retained);
 return result;
}
static jint nested(JNIEnv *env,jclass type,jint value) {
 (void)type;
 jstring text=(*env)->NewStringUTF(env,"nested ARM32");
 return value+(*env)->GetStringLength(env,text);
}
JNIEXPORT jlong critical(jbyte narrow,jshort signed16,jlong value,jfloat single,jdouble wide){
 return narrow==-91&&signed16==-12345&&single==1.25f&&wide==3.5?value+7:-1;
}
JNIEXPORT jint JNI_OnLoad(JavaVM *vm,void *unused) {
#ifdef NATIVE_BRIDGE_DEPENDENCIES
 if(!local_interfaces())return JNI_ERR;
 if(!synchronization_family())return JNI_ERR;
 for(unsigned size=1;size<1024;size=size*2+1){
  unsigned char *allocated=original_new_array(size);if(!allocated)return JNI_ERR;
  memset(allocated,0x5a,size);for(unsigned i=0;i<size;i++)if(allocated[i]!=0x5a)return JNI_ERR;
  original_delete_array(allocated);
  char *bytes=malloc(size);if(!bytes)return JNI_ERR;memset(bytes,0x63,size);
  bytes=realloc(bytes,size*2);if(!bytes||bytes[0]!=0x63)return JNI_ERR;free(bytes);
 }
 for(int c=-1;c<256;c++){
  int lower=c>='A'&&c<='Z'?c+'a'-'A':c,upper=c>='a'&&c<='z'?c+'A'-'a':c;
  if(_tolower_tab_[c+1]!=lower||_toupper_tab_[c+1]!=upper)return JNI_ERR;
 }
 unsigned long long (*divide)(unsigned long long,unsigned long long)=(unsigned long long (*)(unsigned long long,unsigned long long))dlsym(RTLD_DEFAULT,"__udivdi3");
 if(!divide||divide(0x100000005ULL,13)!=330382100ULL)return JNI_ERR;
 if(group_value()!=31||peer_value()!=19||strlen("native Bionic dependency")!=24)return JNI_ERR;
 void *late=dlopen("liblate.so",RTLD_NOW|RTLD_GLOBAL);if(!late)return JNI_ERR;
 int (*late_value)(void)=(int (*)(void))dlsym(late,"late_value");
 int (*dependency)(void)=(int (*)(void))dlsym(late,"peer_value");
 int (*global)(void)=(int (*)(void))dlsym(RTLD_DEFAULT,"group_value");
 int (*next)(void)=(int (*)(void))dlsym(RTLD_NEXT,"late_value");
 int (*published)(void)=(int (*)(void))dlsym(RTLD_DEFAULT,"late_value");
 if(!late_value||!dependency||!global||!next||!published||late_value()!=24||dependency()!=19||global()!=31||next()!=24||published()!=24)return JNI_ERR;
 dlerror();if(dlsym(late,"missing_original_symbol")||!dlerror()||dlerror())return JNI_ERR;
 void *retained=dlopen("liblate.so",RTLD_NOW|RTLD_NOLOAD);if(retained!=late)return JNI_ERR;
 if(dlclose(retained)||dlclose(late))return JNI_ERR;
#endif
 (void)unused;JNIEnv *env=0;
 if((*vm)->GetEnv(vm,(void**)&env,JNI_VERSION_1_6)!=JNI_OK)return JNI_ERR;
 jclass type=(*env)->FindClass(env,"ArtSharedJniProbe");
 if(!type)return JNI_ERR;
 JNINativeMethod methods[]={{"roundtrip","(BSJFDLjava/lang/String;[I)J",(void*)roundtrip},{"nested","(I)I",(void*)nested}};
 if((*env)->RegisterNatives(env,type,methods,2))return JNI_ERR;
 return JNI_VERSION_1_6;
}
