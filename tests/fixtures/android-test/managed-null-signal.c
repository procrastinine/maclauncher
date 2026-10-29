#include <jni.h>
#include <inttypes.h>
#include <stddef.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
static struct sigaction previous;
static volatile sig_atomic_t delivered;
static void application_signal(int signo,siginfo_t *info,void *context){
  (void)signo;(void)context;
  if(info&&info->si_code>0){
    static const char message[]="FAIL original managed-null fault reached the application SIGSEGV handler\n";
    write(STDERR_FILENO,message,sizeof(message)-1);_exit(66);
  }
  delivered++;
}
JNIEXPORT void JNICALL Java_ManagedNullSignalProbe_install(JNIEnv *env,jclass type){
  (void)env;(void)type;struct sigaction action={.sa_sigaction=application_signal,.sa_flags=SA_SIGINFO};sigemptyset(&action.sa_mask);
  if(sigaction(SIGSEGV,&action,&previous))_exit(67);
  if(raise(SIGSEGV))_exit(68);
}
JNIEXPORT jint JNICALL Java_ManagedNullSignalProbe_delivered(JNIEnv *env,jclass type){(void)env;(void)type;return delivered;}
JNIEXPORT void JNICALL Java_ManagedNullSignalProbe_restore(JNIEnv *env,jclass type){(void)env;(void)type;sigaction(SIGSEGV,&previous,0);}

/* Pinned ART ed6c006bd06ae060bd9698fd2cb25c4865512ec3:
 * runtime/art_method.h fields and EntryPointFromQuickCompiledCodeOffset(k64).
 * Executable::InitializeFromArtMethod copies the original access flags/index;
 * JNI field access avoids assuming any managed-object field offset. */
struct pinned_art_method {
  uint32_t declaring_class,access_flags,dex_method_index;
  uint16_t method_index,hotness_count;
  uint64_t data,quick_entry;
};
_Static_assert(sizeof(struct pinned_art_method)==32,"Pinned ARM64 ArtMethod size");
_Static_assert(offsetof(struct pinned_art_method,quick_entry)==24,"Pinned ARM64 quick entry offset");

static int mapped(uintptr_t address,size_t bytes,int executable,char *name,size_t capacity){
  FILE *maps=fopen("/proc/self/maps","re");if(!maps)return 0;
  char line[8192],permissions[5];uintptr_t begin,end;int offset,found=0;
  while(fgets(line,sizeof(line),maps)){
    offset=0;
    if(sscanf(line,"%" SCNxPTR "-%" SCNxPTR " %4s %*s %*s %*s %n",&begin,&end,permissions,&offset)!=3||!offset)continue;
    if(address<begin||address>=end||bytes>end-address||permissions[0]!='r'||(executable&&permissions[2]!='x'))continue;
    char *file=line+offset;file[strcspn(file,"\n")]=0;
    if(strlen(file)>=capacity)break;
    memcpy(name,file,strlen(file)+1);found=1;break;
  }
  fclose(maps);return found;
}
static jlong failure(JNIEnv *env,const char *message){
  jclass error=(*env)->FindClass(env,"java/lang/AssertionError");
  if(error)(*env)->ThrowNew(env,error,message);return 0;
}
JNIEXPORT jlong JNICALL Java_ManagedNullSignalProbe_invokeAot(JNIEnv *env,jclass type,jobject channel,jobject reflected,jlongArray pattern){
  (void)type;
  jclass executable=(*env)->FindClass(env,"java/lang/reflect/Executable");if(!executable)return 0;
  jfieldID method_field=(*env)->GetFieldID(env,executable,"artMethod","J");if(!method_field)return 0;
  jfieldID flags_field=(*env)->GetFieldID(env,executable,"accessFlags","I");if(!flags_field)return 0;
  jfieldID index_field=(*env)->GetFieldID(env,executable,"dexMethodIndex","I");if(!index_field)return 0;
  uintptr_t address=(uintptr_t)(*env)->GetLongField(env,reflected,method_field);
  char method_mapping[4096],code_mapping[4096];
  if(!address||address%8||!mapped(address,sizeof(struct pinned_art_method),0,method_mapping,sizeof(method_mapping)))return failure(env,"Original Executable.artMethod is not a readable ARM64 method");
  struct pinned_art_method before,after;memcpy(&before,(void *)address,sizeof(before));
  if(before.access_flags!=(uint32_t)(*env)->GetIntField(env,reflected,flags_field)||before.dex_method_index!=(uint32_t)(*env)->GetIntField(env,reflected,index_field)||before.access_flags&0x108u)
    return failure(env,"Original Executable and pinned managed instance ArtMethod layout disagree");
  /* AIM's pinned heap-window patch normalizes nonzero logical image pointers. */
  uintptr_t entry=(uintptr_t)before.quick_entry;
  if(entry&&entry<UINT64_C(0x100000000))entry+=UINT64_C(0x10000000000);
  if(!mapped(entry,4,1,code_mapping,sizeof(code_mapping))||strcmp(code_mapping,"/system/framework/arm64/boot-framework.oat"))return failure(env,"Original quick dispatch is not mapped executable boot-framework AOT");
  jmethodID method=(*env)->FromReflectedMethod(env,reflected);if(!method)return 0;
  jclass owner=(*env)->FindClass(env,"android/app/NotificationChannel");if(!owner)return 0;
  jmethodID expected=(*env)->GetMethodID(env,owner,"setVibrationPattern","([J)V");if(!expected)return 0;
  if(method!=expected)return failure(env,"Original reflected method differs from NotificationChannel.setVibrationPattern");
  /* Original JNI -> ArtMethod::Invoke -> art_quick_invoke_stub loads this exact
   * quick entry. The test launches with JIT disabled and no interpreter/debug flag. */
  jvalue args[1]={{.l=pattern}};(*env)->CallNonvirtualVoidMethodA(env,channel,owner,method,args);
  if((*env)->ExceptionCheck(env))return 0;
  memcpy(&after,(void *)address,sizeof(after));
  if(after.quick_entry!=before.quick_entry||after.dex_method_index!=before.dex_method_index||!mapped(entry,4,1,code_mapping,sizeof(code_mapping))||strcmp(code_mapping,"/system/framework/arm64/boot-framework.oat"))return failure(env,"Original AOT dispatch changed during JNI invocation");
  printf("PASS original JNI AOT dispatch NotificationChannel.setVibrationPattern %s entry=0x%" PRIxPTR " mapping=%s\n",pattern?"non-null":"null",entry,code_mapping);
  return (jlong)entry;
}
