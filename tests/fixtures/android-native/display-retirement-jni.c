#include <jni.h>
#include <stdio.h>
#include <stdint.h>
#include "display-adapter.h"
#include "display-snapshot.h"
static KLDisplayAdapter* owner;static int released;
int kl_display_snapshot_read(void*window,KLDisplaySnapshot*out,char*error,size_t capacity){if(!window){snprintf(error,capacity,"Injected unbound native screen");return 0;}*out=(KLDisplaySnapshot){.screenId=42,.refreshRate=119.88f,.refreshSource=1,.windowWidth=640,.windowHeight=400};return 1;}
JNIEXPORT void JNICALL Java_DisplayRetirementProbe_open(JNIEnv*e,jclass c,jboolean bad){(void)c;owner=kl_display_adapter_create(e);if(owner)kl_display_adapter_update(e,owner,bad?NULL:(void*)1,640,400);}
JNIEXPORT jboolean JNICALL Java_DisplayRetirementProbe_stop(JNIEnv*e,jclass c,jthrowable failure){(void)c;if(failure)(*e)->Throw(e,failure);return kl_display_adapter_stop(e,owner);}
JNIEXPORT jboolean JNICALL Java_DisplayRetirementProbe_destroy(JNIEnv*e,jclass c,jthrowable failure){(void)c;if(failure)(*e)->Throw(e,failure);int okay=kl_display_adapter_destroy(e,owner);if(okay){owner=NULL;released++;}return okay;}
JNIEXPORT void JNICALL Java_DisplayRetirementProbe_update(JNIEnv*e,jclass c){(void)c;kl_display_adapter_update(e,owner,(void*)1,800,600);}
JNIEXPORT jint JNICALL Java_DisplayRetirementProbe_releases(JNIEnv*e,jclass c){(void)e;(void)c;return released;}
