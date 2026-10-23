#include <jni.h>
#include <signal.h>
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
