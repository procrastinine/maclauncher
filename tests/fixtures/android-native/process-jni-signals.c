#include "process-ids.h"
#include <jni.h>
#include <assert.h>
#include <dlfcn.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

static int notification=-1;
static void received(int value){if(value==SIGUSR1)(void)write(notification,"S",1);}
static int next(int fd,char expected){
    struct pollfd ready={.fd=fd,.events=POLLIN};char byte=0;
    return poll(&ready,1,1500)>0&&read(fd,&byte,1)==1&&byte==expected;
}
int main(int argc,char **argv){
    assert(argc==3&&klj_process_ids_configure(argv[1])>0);
    void *library=dlopen(argv[2],RTLD_NOW|RTLD_LOCAL);
    if(!library)fprintf(stderr,"%s\n",dlerror());
    assert(library);
    typedef void (*Signal)(JNIEnv*,jclass,jint,jint);
    Signal quiet=dlsym(library,"Java_android_os_Process_sendSignalQuiet");
    Signal normal=dlsym(library,"Java_android_os_Process_sendSignal");
    Signal throwing=dlsym(library,"Java_android_os_Process_sendSignalThrows");
    assert(quiet&&normal&&throwing);
    assert(!klj_process_publish_principal(10024));
    int channel[2];assert(!pipe(channel));
    int child=klj_process_fork();assert(child>=0);
    if(!child){
        close(channel[0]);notification=channel[1];
        struct sigaction action={.sa_handler=received};sigemptyset(&action.sa_mask);
        if(sigaction(SIGUSR1,&action,NULL)||write(notification,"R",1)!=1)_exit(2);
        for(;;)pause();
    }
    close(channel[1]);pid_t host=klj_process_child_host(child);assert(host>0);
    int success=next(channel[0],'R');
    if(success){quiet(NULL,NULL,child,10);success=next(channel[0],'S');}
    if(success){normal(NULL,NULL,child,10);success=next(channel[0],'S');}
    /* Successful original JNI calls do not access JNIEnv. All three routes
     * must reach the same real native lease owner and child signal handler. */
    if(success){throwing(NULL,NULL,child,10);success=next(channel[0],'S');}
    /* Always retire this exact physical child, including a failing control. */
    if(success)quiet(NULL,NULL,child,15);
    else assert(!kill(host,SIGKILL));
    int status=0;assert(klj_process_wait_native(child,&status,0,NULL)==child);
    assert(WIFSIGNALED(status)&&WTERMSIG(status)==(success?SIGTERM:SIGKILL));
    close(channel[0]);assert(!klj_process_child_host(child));
    assert(success&&"Process JNI must signal the same retained Android children as native imports");
    assert(!dlclose(library));
    puts("PASS Process JNI signal variants share native child leases, delivery and retirement");
}
