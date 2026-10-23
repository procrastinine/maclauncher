#include "arm32-bridge.h"
#include <jni.h>
#include <stdlib.h>
#include <string.h>
struct Callback {JNIEnv *env;jclass type;jmethodID method;};
static uint64_t invoke(uint64_t address){
 struct KljArtArm32Callback *request=(void*)(uintptr_t)address;
 struct Callback *state=(void*)(uintptr_t)request->cookie;
 const uint32_t *words=(void*)(uintptr_t)request->words;
 return (uint32_t)(*state->env)->CallStaticIntMethod(state->env,state->type,state->method,(jint)words[0]);
}
static int call(JNIEnv *env,struct KljArtArm32 *packet){
 int64_t status=klj_art_host(9,packet,sizeof(*packet));
 if(status&&!(*env)->ExceptionCheck(env)){
  jclass type=(*env)->FindClass(env,"java/lang/IllegalStateException");
  if(type)(*env)->ThrowNew(env,type,packet->error[0]?packet->error:"ARM32 transport failed");
 }
 return status==0;
}
JNIEXPORT void JNICALL Java_ArtArm32Probe_run(JNIEnv *env,jclass type,jbyteArray input){
 uint64_t memory=0,thread=0;uint8_t *code=0;
 struct KljArtArm32 packet={.operation=KLJ_ART_ARM32_MEMORY};
 if(!call(env,&packet))return;memory=packet.result;
 packet=(struct KljArtArm32){.operation=KLJ_ART_ARM32_THREAD,.parent=memory};
 if(!call(env,&packet))goto close;thread=packet.result;
 jsize size=(*env)->GetArrayLength(env,input);code=malloc((size_t)size);
 if(!code){jclass error=(*env)->FindClass(env,"java/lang/OutOfMemoryError");if(error)(*env)->ThrowNew(env,error,"ARM32 test bytes");goto close;}
 (*env)->GetByteArrayRegion(env,input,0,size,(jbyte*)code);if((*env)->ExceptionCheck(env))goto close;
 packet=(struct KljArtArm32){.operation=KLJ_ART_ARM32_MAP,.token=memory,.address=0x10000000,.length=(uint32_t)((size+4095)&~4095),.permission=7};
 // Map exact initialized bytes plus zero-filled page tail owned by the fixture.
 void *padded=calloc(1,packet.length);if(!padded){jclass error=(*env)->FindClass(env,"java/lang/OutOfMemoryError");if(error)(*env)->ThrowNew(env,error,"ARM32 test mapping");goto close;}memcpy(padded,code,(size_t)size);packet.buffer=(uintptr_t)padded;
 int mapped=call(env,&packet);free(padded);if(!mapped)goto close;
 uint32_t entries[2];memcpy(entries,code,sizeof(entries));
 struct KljArtArm32Value arguments[3]={{5,1,4},{UINT64_C(0x100000006),2,8},{7,1,4}};
 packet=(struct KljArtArm32){.operation=KLJ_ART_ARM32_CALL,.token=thread,.address=entries[0],.buffer=(uintptr_t)arguments,.count=3};
 if(!call(env,&packet))goto close;
 if(packet.result!=UINT64_C(0x100000012)){jclass error=(*env)->FindClass(env,"java/lang/AssertionError");(*env)->ThrowNew(env,error,"ARM32 wide alignment");goto close;}
 struct Callback state={env,type,(*env)->GetStaticMethodID(env,type,"callback","(I)I")};
 if(!state.method)goto close;
 packet=(struct KljArtArm32){.operation=KLJ_ART_ARM32_IMPORT,.token=memory,.function=(uintptr_t)invoke,.cookie=(uintptr_t)&state,.count=1};
 if(!call(env,&packet))goto close;
 arguments[0]=(struct KljArtArm32Value){packet.result,1,4};arguments[1]=(struct KljArtArm32Value){6,1,4};
 packet=(struct KljArtArm32){.operation=KLJ_ART_ARM32_CALL,.token=thread,.address=entries[1],.buffer=(uintptr_t)arguments,.count=2};
 if(!call(env,&packet))goto close;
 if(packet.result!=45){jclass error=(*env)->FindClass(env,"java/lang/AssertionError");(*env)->ThrowNew(env,error,"ARM32 original ART callback");goto close;}
 arguments[1].bits=99;if(!call(env,&packet))goto close;
 if(!(*env)->ExceptionCheck(env)){jclass error=(*env)->FindClass(env,"java/lang/AssertionError");(*env)->ThrowNew(env,error,"ART callback exception missing");goto close;}
 jthrowable failure=(*env)->ExceptionOccurred(env);(*env)->ExceptionClear(env);
 jclass expected=(*env)->FindClass(env,"java/lang/IllegalArgumentException");
 if(!(*env)->IsInstanceOf(env,failure,expected))(*env)->Throw(env,failure);
close:
 free(code);
 if(thread){packet=(struct KljArtArm32){.operation=KLJ_ART_ARM32_CLOSE,.token=thread};call(env,&packet);}
 if(memory){packet=(struct KljArtArm32){.operation=KLJ_ART_ARM32_CLOSE,.token=memory};call(env,&packet);}
}
