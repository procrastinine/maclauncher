#include KLJ_LOOPER_SOURCE
#include <unistd.h>
#include <fcntl.h>
extern void *kl_ndk_lookup(const char *);
static _Atomic int borrowed,released,called,failures;
static JavaVM *test_vm;
static int64_t borrow_fd(int guest,int *native,void **pin){
 int *p=malloc(sizeof *p);if(!p)return -12;*p=dup(guest);if(*p<0){free(p);return -9;}
 *native=*p;*pin=p;borrowed++;return 0;
}
static int64_t release_fd(void *pin){int*p=pin;int r=close(*p);free(p);released++;return r?-5:0;}
static int64_t invoke_callback(void*unused,JNIEnv*env,uintptr_t caller,KljCallPacket*p){
 (void)unused;(void)env;(void)caller;
 int(*fn)(int,int,void*)=(void*)p->target;
 p->result_x[0]=fn((int)p->x[0],(int)p->x[1],(void*)p->x[2]);return 0;
}
static int fd_callback(int fd,int events,void*data){(void)events;char c;read(fd,&c,1);called++;return (int)(intptr_t)data;}
static void check(const char*name,int actual,int expected){
 printf("%s actual=%d expected=%d\n",name,actual,expected);if(actual!=expected)failures++;
}
typedef struct {int mode,pipe[2],stage;ALooper*looper;pthread_mutex_t mutex;pthread_cond_t cond;} Case;
static void *worker(void *arg){
 Case*c=arg;c->looper=prepare(ALOOPER_PREPARE_ALLOW_NON_CALLBACKS);
 check("prepare",c->looper!=NULL,1);if(c->mode!=2)acquire(c->looper);
 if(c->mode==7)acquire(c->looper);
 check("add",add(NULL,0,c->looper,c->pipe[0],-1,ALOOPER_EVENT_INPUT,fd_callback,(void*)(intptr_t)(c->mode==4?0:1)),1);
 if(c->mode==4){write(c->pipe[1],"x",1);int result=ALOOPER_POLL_WAKE;for(int i=0;i<4&&result==ALOOPER_POLL_WAKE;i++)result=poll_loop(0,100,NULL,NULL,NULL);check("live-callback",result,ALOOPER_POLL_CALLBACK);check("auto-remove",remove_fd(c->looper,c->pipe[0]),0);release(c->looper);}
 if(c->mode==6){
  write(c->pipe[1],"x",1);klj_jni_thread_retire();
  /* An already owned host poll can observe a callback after retirement. */
  int result=ALOOPER_POLL_WAKE;for(int i=0;i<4&&result==ALOOPER_POLL_WAKE;i++)result=p_pollOnce(100,NULL,NULL,NULL);
  check("retired-callback-host-result",result,ALOOPER_POLL_CALLBACK);
  check("retired-callback-not-invoked",called,1);
  check("retired-callback-real-auto-remove",remove_fd(c->looper,c->pipe[0]),0);release(c->looper);
 }
 if(c->mode==1||c->mode==5){
  klj_jni_thread_retire();
  check("retired-add-denied",add(NULL,0,c->looper,c->pipe[0],-1,ALOOPER_EVENT_INPUT,fd_callback,NULL),-1);
  check("retired-poll-denied",poll_loop(0,0,NULL,NULL,NULL),ALOOPER_POLL_ERROR);
  pthread_mutex_lock(&c->mutex);c->stage=1;pthread_cond_signal(&c->cond);
  while(c->stage!=2)pthread_cond_wait(&c->cond,&c->mutex);pthread_mutex_unlock(&c->mutex);
 }
 return NULL;
}
static void run_case(int mode){
 Case c={.mode=mode,.mutex=PTHREAD_MUTEX_INITIALIZER,.cond=PTHREAD_COND_INITIALIZER};pipe(c.pipe);pthread_t thread;
 int before=borrowed-released;pthread_create(&thread,NULL,worker,&c);
 if(mode==1||mode==5){pthread_mutex_lock(&c.mutex);while(c.stage!=1)pthread_cond_wait(&c.cond,&c.mutex);pthread_mutex_unlock(&c.mutex);}
 else pthread_join(thread,NULL);
 if(mode==0||mode==1){
  check(mode==0?"physical-end-retains-pin":"java-end-retains-pin",borrowed-released,before+1);
  check(mode==0?"physical-end-external-remove":"java-end-external-remove",remove_fd(c.looper,c.pipe[0]),1);
  check("second-remove",remove_fd(c.looper,c.pipe[0]),0);release(c.looper);
 } else if(mode==3||mode==5)release(c.looper);
 else if(mode==7){release(c.looper);check("second-acquire-retains-pin",borrowed-released,before+1);check("second-acquire-real-remove",remove_fd(c.looper,c.pipe[0]),1);release(c.looper);}
 if(mode==1||mode==5){pthread_mutex_lock(&c.mutex);c.stage=2;pthread_cond_signal(&c.cond);pthread_mutex_unlock(&c.mutex);pthread_join(thread,NULL);}
 check("descriptor-leases-balanced",borrowed-released,before);
 close(c.pipe[0]);close(c.pipe[1]);pthread_cond_destroy(&c.cond);pthread_mutex_destroy(&c.mutex);
}
int main(void){
 JNIEnv*env=NULL;JavaVMInitArgs args={.version=JNI_VERSION_1_8,.nOptions=0,.ignoreUnrecognized=JNI_FALSE};
 if(JNI_CreateJavaVM(&test_vm,(void**)&env,&args)!=JNI_OK)return 70;
 static const KljBionicPollFdApi poll={sizeof poll,1,borrow_fd,release_fd};
 KljBionicLooperOwner input={.resolve=kl_ndk_lookup,.invoke=invoke_callback,.poll=&poll};
 check("owner-prepare",klj_bionic_looper_prepare(env,&input),0);
 for(int i=0;i<8;i++)run_case(i);
 check("guest-callback-count",called,1);check("retired-thread-nodes",threads!=NULL,0);
 printf("RESULT failures=%d borrowed=%d released=%d\n",failures,borrowed,released);fflush(stdout);
 (*test_vm)->DestroyJavaVM(test_vm);return failures?1:0;
}
