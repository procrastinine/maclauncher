#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <time.h>
#include <stdlib.h>
#include <unistd.h>
#include <pthread.h>
#include <stdatomic.h>
#include <poll.h>
#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include "process-ids.h"
#include "native-clock/clock-domain.h"
/* Error translation is outside this test; exercise the owned POSIX wait body. */
int kl_errno_to_linux(int value){return value;}
#include "native-clock/clock-sleep.h"
static uint64_t ns(struct timespec v){return (uint64_t)v.tv_sec*1000000000ull+v.tv_nsec;}
#ifdef KLJ_ORIGINAL_BIONIC_CPU
extern int klj_original_clock_getcpuclockid(pid_t,int *);
#endif
/* Exact Linux CPUCLOCK representation used by original Bionic. */
static int cpu_clock(int id,int thread,unsigned which){return (int32_t)((~(uint32_t)id<<3)|(thread?4:0)|which);}
static void busy(void){
 uint64_t until=clock_gettime_nsec_np(CLOCK_UPTIME_RAW)+15000000;
 while(clock_gettime_nsec_np(CLOCK_UPTIME_RAW)<until)atomic_signal_fence(memory_order_seq_cst);
}
static _Atomic int worker_id,worker_stop;
static void *worker(void *unused){
 (void)unused;int id=klj_thread_id();assert(id>0);
 struct timespec value;assert(klj_clock_read(cpu_clock(id,0,2),&value)==0);
 assert(klj_clock_resolution(cpu_clock(id,0,2),NULL)==-1&&errno==EINVAL);
 atomic_store(&worker_id,id);
 while(!atomic_load(&worker_stop))busy();
 return NULL;
}
static void cpu_clocks(void){
 int process=klj_process_id();assert(process>0);
 assert(klj_thread_id()==process);
#ifdef KLJ_ORIGINAL_BIONIC_CPU
 int original=0;errno=EDOM;
 assert(!klj_original_clock_getcpuclockid(process,&original)&&original==cpu_clock(process,0,2)&&errno==EDOM);
 assert(klj_original_clock_getcpuclockid(1000000,&original)==ESRCH&&original==cpu_clock(process,0,2)&&errno==EDOM);
#endif
 struct timespec before,after,t;
 for(int thread=0;thread<=1;thread++){
  clockid_t native=thread?CLOCK_THREAD_CPUTIME_ID:CLOCK_PROCESS_CPUTIME_ID;
  assert(clock_gettime(native,&before)==0);
  assert(klj_clock_read(cpu_clock(process,thread,2),&t)==0);
  assert(clock_gettime(native,&after)==0);
  /* Darwin's CPU query families round independently to microseconds. */
  assert(ns(t)+1000000>=ns(before)&&ns(t)<=ns(after)+1000000);
  uint64_t start=ns(t),native_start=ns(before);busy();
  assert(klj_clock_read(cpu_clock(process,thread,2),&t)==0);
  assert(clock_gettime(native,&after)==0);
  uint64_t elapsed=ns(t)-start,native_elapsed=ns(after)-native_start;
  assert(elapsed>1000000&&elapsed+1000000>=native_elapsed&&elapsed<=native_elapsed+1000000);
  for(unsigned which=0;which<3;which++){
   assert(klj_clock_read(cpu_clock(0,thread,which),&t)==0);
   assert(klj_clock_read(cpu_clock(process,thread,which),&t)==0);
   assert(klj_clock_resolution(cpu_clock(process,thread,which),NULL)==0);
   assert(klj_clock_resolution(cpu_clock(process,thread,which),&t)==0&&ns(t)>0);
  }
 }
 assert(klj_clock_read(cpu_clock(0,0,1),&before)==0);
 assert(klj_clock_read(cpu_clock(0,0,0),&after)==0&&ns(before)<=ns(after));
 assert(klj_clock_read(cpu_clock(0,1,2),NULL)==-1&&errno==EFAULT);
 assert(klj_clock_read(cpu_clock(0,0,3),&t)==-1&&errno==EINVAL);
 assert(klj_clock_read(cpu_clock(1000000,0,2),&t)==-1&&errno==EINVAL);
 pthread_t thread;assert(!pthread_create(&thread,NULL,worker,NULL));
 while(!atomic_load(&worker_id))sched_yield();
 int tid=atomic_load(&worker_id);assert(tid!=process);
 assert(klj_clock_read(cpu_clock(tid,1,2),&before)==0);busy();
 assert(klj_clock_read(cpu_clock(tid,1,2),&after)==0&&ns(after)>ns(before));
 assert(klj_clock_resolution(cpu_clock(tid,1,2),NULL)==0);
 assert(klj_clock_read(cpu_clock(tid,0,2),&t)==-1&&errno==EINVAL);
 atomic_store(&worker_stop,1);assert(!pthread_join(thread,NULL));
 assert(klj_clock_read(cpu_clock(tid,1,2),&t)==-1&&errno==EINVAL);
 int ready[2],stop[2];assert(!pipe(ready)&&!pipe(stop));pid_t child=fork();assert(child>=0);
 if(!child){
  close(ready[0]);close(stop[1]);int id=klj_process_id();assert(id>0);busy();
  assert(write(ready[1],&id,sizeof id)==sizeof id);close(ready[1]);
  struct pollfd wait={.fd=stop[0],.events=POLLIN};while(!poll(&wait,1,0))busy();
  close(stop[0]);_exit(0);
 }
 close(ready[1]);close(stop[0]);int child_id=0;assert(read(ready[0],&child_id,sizeof child_id)==sizeof child_id);close(ready[0]);
 assert(child_id!=process&&klj_clock_read(cpu_clock(child_id,0,2),&before)==0);busy();
 assert(klj_clock_read(cpu_clock(child_id,0,2),&after)==0&&ns(after)>ns(before));
 assert(klj_clock_resolution(cpu_clock(child_id,0,2),NULL)==0);
 assert(klj_clock_read(cpu_clock(child_id,1,2),&t)==-1&&errno==EINVAL);
 close(stop[1]);int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&!WEXITSTATUS(status));
 assert(klj_clock_read(cpu_clock(child_id,0,2),&t)==-1&&errno==EINVAL);
}
int main(void){
 /* Guest process and thread identities come from the shared owner, backed by a private lease directory. */
 char ids[PATH_MAX];snprintf(ids,sizeof ids,"%s/klj-ids-XXXXXX",getenv("TMPDIR")?getenv("TMPDIR"):"/tmp");assert(mkdtemp(ids)&&klj_process_ids_configure(ids)>0);
 cpu_clocks();
 struct timespec t,remaining={7,8},bad={0,1000000000},expired={-1,0};
 errno=0;assert(klj_clock_read(999,&t)==-1&&errno==EINVAL);
 errno=0;assert(klj_clock_read(1,NULL)==-1&&errno==EFAULT);
 assert(!klj_nsec_valid(NULL)&&!klj_nsec_valid(&bad));
 assert(ns(klj_clock_remaining(1,&expired))==0);
 for(int i=0;i<10000;i++){
  uint64_t before=clock_gettime_nsec_np(CLOCK_UPTIME_RAW);assert(klj_clock_read(1,&t)==0);uint64_t after=clock_gettime_nsec_np(CLOCK_UPTIME_RAW);assert(ns(t)>=before&&ns(t)<=after);
  before=clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);assert(klj_clock_read(7,&t)==0);after=clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW);assert(ns(t)>=before&&ns(t)<=after);
  before=clock_gettime_nsec_np(CLOCK_REALTIME);assert(klj_clock_read(11,&t)==0);after=clock_gettime_nsec_np(CLOCK_REALTIME);assert(ns(t)>=before&&ns(t)<=after);
 }
 assert(klj_clock_resolution(11,NULL)==0);
 struct timespec zero={0,0};errno=EDOM;assert(klj_domain_clock_nanosleep(1,0,&zero,&remaining)==0&&errno==EDOM);
 assert(klj_domain_clock_nanosleep(1,0,&bad,&remaining)==EINVAL&&errno==EDOM);
 assert(klj_domain_clock_nanosleep(7,0,&zero,&remaining)==ENOTSUP&&errno==EDOM);
 assert(klj_domain_clock_nanosleep(1,2,&zero,&remaining)==EINVAL&&errno==EDOM);
 const int clocks[]={0,1,11};for(unsigned i=0;i<sizeof clocks/sizeof clocks[0];i++){int clock=clocks[i];
  assert(klj_clock_read(clock,&t)==0);t.tv_nsec+=2000000;if(t.tv_nsec>=1000000000){t.tv_sec++;t.tv_nsec-=1000000000;}
  remaining=(struct timespec){7,8};assert(klj_domain_clock_nanosleep(clock,1,&t,&remaining)==0);
  struct timespec now;assert(klj_clock_read(clock,&now)==0&&ns(now)>=ns(t));assert(remaining.tv_sec==7&&remaining.tv_nsec==8);
  struct timespec past={0,0};assert(klj_domain_clock_nanosleep(clock,1,&past,&remaining)==0);
 }
 puts("PASS clock domains, strict native brackets, encoded process/thread PROF/VIRT/SCHED with live and retired targets, TAI zero offset, absolute deadlines");
}
