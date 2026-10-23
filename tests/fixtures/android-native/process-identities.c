#include "process-ids.h"
#include "thread-identity.h"
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

extern int _tlv_atexit(void (*)(void *),void *);
static const char *directory;
static pthread_key_t late_key;
static _Atomic int callbacks,ready,leave;
typedef struct {int reserved,actual;} Worker;
static void inspect(int id,int expected_kind,int process,pid_t physical){
    pid_t host=0;int kind=0,parent=0;
    assert(!klj_process_id_owner(directory,id,&host,&kind,&parent));
    assert(host==physical&&kind==expected_kind&&parent==process);
}
static void late(void *value){
    Worker *worker=value;
    assert(klj_thread_id()==worker->actual);
    inspect(worker->actual,2,klj_process_id(),getpid());
    atomic_fetch_add(&callbacks,1);
}
static void *run(void *value){
    Worker *worker=value;
    worker->actual=worker->reserved?klj_thread_id_adopt(worker->reserved):klj_thread_id();
    assert(worker->actual>=2&&worker->actual<=65535);
    assert(!worker->reserved||worker->actual==worker->reserved);
    assert(klj_thread_id()==worker->actual);
    assert(!pthread_setspecific(late_key,worker));
    assert(!_tlv_atexit(late,worker));
    atomic_fetch_add(&ready,1);
    while(!atomic_load(&leave))usleep(1000);
    return NULL;
}
int main(int argc,char **argv){
    assert(argc==2);directory=argv[1];
    int pid=klj_process_ids_configure(directory);assert(pid>=2&&pid<=65535);
    assert(klj_thread_id()==pid);
    assert(klj_process_id_from_host(getpid())==pid);
    errno=E2BIG;assert(!klj_process_child_id(getpid())&&errno==E2BIG);
    assert(!klj_process_child_id(0)&&!klj_process_child_id(-1));
    inspect(pid,1,pid,getpid());
    assert(!pthread_key_create(&late_key,late));
    Worker workers[32]={0};pthread_t threads[32];
    for(int i=0;i<32;i++){
        if(i%2)workers[i].reserved=klj_thread_id_reserve();
        assert(!pthread_create(&threads[i],NULL,run,&workers[i]));
    }
    while(atomic_load(&ready)!=32)usleep(1000);
    for(int i=0;i<32;i++){
        inspect(workers[i].actual,2,pid,getpid());
        assert(workers[i].actual!=pid);
        for(int j=0;j<i;j++)assert(workers[i].actual!=workers[j].actual);
    }
    atomic_store(&leave,1);
    for(int i=0;i<32;i++)assert(!pthread_join(threads[i],NULL));
    assert(atomic_load(&callbacks)==64);
    /* Target lookup collects only physically dead Mach threads. All actual
     * TLS and POSIX destructor callbacks above retained their original ID. */
    for(int i=0;i<32;i++){
        assert(klj_thread_acquire(workers[i].actual)==MACH_PORT_NULL&&errno==ESRCH);
        pid_t host;int kind,process;
        assert(klj_process_id_query(workers[i].actual,&host,&kind,&process)<0&&errno==ESRCH);
    }
    int messages[2],ack[2];assert(!pipe(messages)&&!pipe(ack));
    pid_t child=fork();assert(child>=0);
    if(!child){
        close(messages[0]);close(ack[1]);
        int child_pid=klj_process_id();assert(child_pid>=2&&child_pid<=65535&&child_pid!=pid);
        assert(klj_thread_id()==child_pid);
        assert(!klj_process_child_id(getpid()));
        assert(write(messages[1],&child_pid,sizeof child_pid)==sizeof child_pid);
        char byte;assert(read(ack[0],&byte,1)==1);_exit(0);
    }
    close(messages[1]);close(ack[0]);int child_pid;
    assert(read(messages[0],&child_pid,sizeof child_pid)==sizeof child_pid);
    for(int i=0;i<64;i++)assert(klj_process_id_from_host(child)==child_pid);
    assert(klj_process_child_retain(child)==child_pid);
    assert(klj_process_child_host(child_pid)==child);
    assert(klj_process_child_id(child)==child_pid);
    errno=ESPIPE;assert(!klj_process_child_id(getpid())&&errno==ESPIPE);
    assert(write(ack[1],"x",1)==1);
    siginfo_t state={0};assert(!waitid(P_PID,(id_t)child,&state,WEXITED|WNOWAIT));
    assert(klj_process_child_id(child)==child_pid);
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status));
    assert(klj_process_child_reaped(child)==child_pid);
    assert(!klj_process_child_host(child_pid));
    assert(!klj_process_child_id(child));
    close(messages[0]);close(ack[1]);pthread_key_delete(late_key);
    puts("PASS shared compact process/thread leases, reserved adoption, late TLS identity, Mach-death retirement, repeated reverse lookup and retained child wait");
}
