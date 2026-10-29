#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
#include <sched.h>
#include <time.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/wait.h>

long klj_futex(int32_t*,int,uint32_t,const struct timespec*,int32_t*,uint32_t);
enum { WAIT=0, WAKE=1, REQUEUE=3, CMP_REQUEUE=4, WAKE_OP=5, WAIT_BITSET=9, WAKE_BITSET=10, PRIVATE=128, REALTIME=256 };
#define CHECK(value) do { if(!(value)) { fprintf(stderr,"FAIL line %d: %s\n",__LINE__,#value); abort(); } } while(0)

/* Find two actual independent words in the same former broadcast bucket. */
static int32_t words[257];
static int32_t *first_word,*second_word;
static unsigned old_hash(const void *address){return (unsigned)(((uintptr_t)address>>2)*UINT64_C(0x9e3779b97f4a7c15)>>56);}
static void find_collision(void){
    int32_t *buckets[256]={0};
    for(unsigned i=0;i<257;i++){
        unsigned bucket=old_hash(&words[i]);
        if(buckets[bucket]){first_word=buckets[bucket];second_word=&words[i];return;}
        buckets[bucket]=&words[i];
    }
    CHECK(0);
}
typedef struct {
    _Atomic int ready,completed,credits;
} Group;
typedef struct {
    Group *group;
    int32_t *address;
    uint32_t mask;
    int operation;
    _Atomic int finished;
    pthread_t thread;
} Waiter;

static int64_t now(void){struct timespec time;CHECK(clock_gettime(CLOCK_MONOTONIC,&time)==0);return (int64_t)time.tv_sec*1000000000+time.tv_nsec;}
static void wait_count(_Atomic int *value,int count){
    int64_t deadline=now()+5000000000LL;
    while(atomic_load(value)<count){CHECK(now()<deadline);sched_yield();}
    CHECK(atomic_load(value)==count);
}
static void *waiter(void *argument){
    Waiter *state=argument;
    atomic_fetch_add(&state->group->ready,1);
    CHECK(klj_futex(state->address,state->operation|PRIVATE,0,NULL,NULL,state->mask)==0);
    /* Credits are issued before each wake. An unsolicited completion, including
     * a broadcast to another address/mask, fails even if scheduling is delayed.
     */
    CHECK(atomic_fetch_sub(&state->group->credits,1)>0);
    atomic_store(&state->finished,1);
    atomic_fetch_add(&state->group->completed,1);
    return NULL;
}
static void start(Waiter *state,Group *group,int32_t *address,int operation,uint32_t mask){
    *state=(Waiter){.group=group,.address=address,.mask=mask,.operation=operation};
    CHECK(pthread_create(&state->thread,NULL,waiter,state)==0);
}
static void wake_one(Group *group,int32_t *address,int operation,uint32_t mask){
    int before=atomic_load(&group->completed);
    int64_t deadline=now()+5000000000LL;
    for(;;){
        atomic_fetch_add(&group->credits,1);
        long result=klj_futex(address,operation|PRIVATE,1,NULL,NULL,mask);
        CHECK(result==0||result==1);
        if(result==1)break;
        CHECK(atomic_fetch_sub(&group->credits,1)>0);
        CHECK(now()<deadline);sched_yield();
    }
    wait_count(&group->completed,before+1);
}
static void join(Waiter *state){void *result=NULL;CHECK(pthread_join(state->thread,&result)==0);CHECK(result==NULL);}
static void move_waiters(int32_t *source,int32_t *destination,int count){
    int moved=0;int64_t deadline=now()+5000000000LL;
    while(moved<count){
        long result=klj_futex(source,REQUEUE|PRIVATE,0,(const struct timespec*)(uintptr_t)(count-moved),destination,0);
        CHECK(result>=0&&result<=count-moved);moved+=(int)result;
        CHECK(now()<deadline);if(!result)sched_yield();
    }
}

static void collisions(void){
    CHECK(first_word!=second_word&&old_hash(first_word)==old_hash(second_word));
    Group first={0},second={0};Waiter waiters[8];
    for(int i=0;i<8;i++)start(&waiters[i],i<4?&first:&second,i<4?first_word:second_word,WAIT,UINT32_MAX);
    wait_count(&first.ready,4);wait_count(&second.ready,4);
    for(int i=0;i<4;i++){wake_one(&first,first_word,WAKE,0);CHECK(atomic_load(&second.completed)==0);}
    CHECK(klj_futex(first_word,WAKE|PRIVATE,INT_MAX,NULL,NULL,0)==0);
    for(int i=0;i<4;i++)wake_one(&second,second_word,WAKE,0);
    for(int i=0;i<8;i++)join(&waiters[i]);
    CHECK(atomic_load(&first.credits)==0&&atomic_load(&second.credits)==0);
}
static void bitsets(void){
    Group first={0},second={0};Waiter waiters[4];
    for(int i=0;i<4;i++)start(&waiters[i],i<2?&first:&second,first_word,WAIT_BITSET,i<2?1:2);
    wait_count(&first.ready,2);wait_count(&second.ready,2);
    CHECK(klj_futex(first_word,WAKE_BITSET|PRIVATE,INT_MAX,NULL,NULL,4)==0);
    for(int i=0;i<2;i++){wake_one(&first,first_word,WAKE_BITSET,1);CHECK(atomic_load(&second.completed)==0);}
    for(int i=0;i<2;i++)wake_one(&second,first_word,WAKE_BITSET,2);
    for(int i=0;i<4;i++)join(&waiters[i]);
}
static void timeouts(void){
    *first_word=1;errno=0;
    CHECK(klj_futex(first_word,WAIT|PRIVATE,0,NULL,NULL,0)==-1&&errno==EAGAIN);*first_word=0;
    struct timespec delay={0,20000000};int64_t before=now();errno=0;
    CHECK(klj_futex(first_word,WAIT|PRIVATE,0,&delay,NULL,0)==-1&&errno==ETIMEDOUT);
    CHECK(now()-before>=10000000);
    struct timespec absolute;CHECK(clock_gettime(CLOCK_UPTIME_RAW,&absolute)==0);errno=0;
    CHECK(klj_futex(first_word,WAIT_BITSET|PRIVATE,0,&absolute,NULL,1)==-1&&errno==ETIMEDOUT);
    CHECK(clock_gettime(CLOCK_REALTIME,&absolute)==0);errno=0;
    CHECK(klj_futex(first_word,WAIT_BITSET|PRIVATE|REALTIME,0,&absolute,NULL,1)==-1&&errno==ETIMEDOUT);
    CHECK(klj_futex(first_word,WAKE|PRIVATE,INT_MAX,NULL,NULL,0)==0);
}
static void requeue(void){
    Group group={0};Waiter waiters[3];
    for(int i=0;i<3;i++)start(&waiters[i],&group,first_word,WAIT,UINT32_MAX);
    wait_count(&group.ready,3);
    errno=0;
    CHECK(klj_futex(first_word,CMP_REQUEUE|PRIVATE,0,(const struct timespec*)(uintptr_t)3,second_word,1)==-1&&errno==EAGAIN);
    move_waiters(first_word,second_word,3);
    CHECK(atomic_load(&group.completed)==0);
    CHECK(klj_futex(first_word,WAKE|PRIVATE,INT_MAX,NULL,NULL,0)==0);
    for(int i=0;i<3;i++)wake_one(&group,second_word,WAKE,0);
    for(int i=0;i<3;i++)join(&waiters[i]);
}
static void wake_operation(void){
    int32_t staging[2]={0};Group first={0},second={0};Waiter waiters[3];
    start(&waiters[0],&first,&staging[0],WAIT_BITSET,1);
    start(&waiters[1],&second,&staging[1],WAIT_BITSET,1);
    start(&waiters[2],&second,&staging[1],WAIT_BITSET,2);
    /* Requeue counts prove enrollment before WAKE_OP changes the compared word. */
    move_waiters(&staging[0],first_word,1);move_waiters(&staging[1],second_word,2);
    atomic_fetch_add(&first.credits,1);
    /* ADD -1; compare the previous value using signed LT 0: 0 < 0 is false. */
    uint32_t encoded=(1u<<28)|(2u<<24)|(0xfffu<<12);
    CHECK(klj_futex(first_word,WAKE_OP|PRIVATE,1,(const struct timespec*)(uintptr_t)1,second_word,encoded)==1);
    CHECK(__atomic_load_n(second_word,__ATOMIC_SEQ_CST)==-1);
    wait_count(&first.completed,1);CHECK(atomic_load(&second.completed)==0);
    /* ADD +2; previous -1 < 0 is true although the new value +1 is positive.
     * Wake exactly one second-address waiter, regardless of its bitset. */
    atomic_fetch_add(&second.credits,1);encoded=(1u<<28)|(2u<<24)|(2u<<12);
    CHECK(klj_futex(first_word,WAKE_OP|PRIVATE,0,(const struct timespec*)(uintptr_t)1,second_word,encoded)==1);
    CHECK(__atomic_load_n(second_word,__ATOMIC_SEQ_CST)==1);
    wait_count(&second.completed,1);
    CHECK(atomic_load(&waiters[1].finished)+atomic_load(&waiters[2].finished)==1);
    int done=atomic_load(&waiters[1].finished)?1:2,remaining=done==1?2:1;
    CHECK(klj_futex(second_word,WAKE_BITSET|PRIVATE,INT_MAX,NULL,NULL,waiters[done].mask)==0);
    wake_one(&second,second_word,WAKE_BITSET,waiters[remaining].mask);
    for(int i=0;i<3;i++)join(&waiters[i]);
    CHECK(atomic_load(&first.credits)==0&&atomic_load(&second.credits)==0);
    *second_word=0;
}
static void cancellation(void){
    Group group={0};Waiter cancelled;
    start(&cancelled,&group,first_word,WAIT,UINT32_MAX);wait_count(&group.ready,1);
    CHECK(pthread_cancel(cancelled.thread)==0);void *result=NULL;
    CHECK(pthread_join(cancelled.thread,&result)==0&&result==PTHREAD_CANCELED);
    CHECK(klj_futex(first_word,WAKE|PRIVATE,INT_MAX,NULL,NULL,0)==0);
    Waiter replacement;start(&replacement,&group,first_word,WAIT,UINT32_MAX);
    wake_one(&group,first_word,WAKE,0);join(&replacement);
    CHECK(atomic_load(&group.credits)==0);
}
typedef struct {int32_t word,other;_Atomic int ready,done;} Shared;
static void shared_processes(void){
    char name[1024];snprintf(name,sizeof name,"%s/maclauncher-futex-XXXXXX",getenv("TMPDIR")?getenv("TMPDIR"):"/tmp");int fd=mkstemp(name);CHECK(fd>=0);CHECK(unlink(name)==0);
    size_t length=(size_t)getpagesize();CHECK(ftruncate(fd,(off_t)length)==0);
    Shared *first=mmap(NULL,length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
    Shared *alias=mmap(NULL,length,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
    CHECK(first!=MAP_FAILED&&alias!=MAP_FAILED&&first!=alias);CHECK(close(fd)==0);
    *first=(Shared){0};pid_t children[4];
    for(int i=0;i<4;i++){
        children[i]=fork();CHECK(children[i]>=0);
        if(!children[i]){
            CHECK(munmap(first,length)==0);
            atomic_fetch_add(&alias->ready,1);
            struct timespec timeout={5,0};
            CHECK(klj_futex(&alias->word,WAIT,0,&timeout,NULL,0)==0);
            atomic_fetch_add(&alias->done,1);_exit(0);
        }
    }
    wait_count(&first->ready,4);
    // PRIVATE uses this process's address, never shared object waiters.
    CHECK(klj_futex(&first->word,WAKE|PRIVATE,INT_MAX,NULL,NULL,0)==0);
    CHECK(klj_futex(&first->other,WAKE,INT_MAX,NULL,NULL,0)==0);
    int woken=0;int64_t deadline=now()+5000000000LL;
    while(woken<4){
        long count=klj_futex(&first->word,WAKE,1,NULL,NULL,0);CHECK(count==0||count==1);
        if(count){++woken;wait_count(&first->done,woken);}
        CHECK(now()<deadline);if(!count)sched_yield();
    }
    CHECK(klj_futex(&alias->word,WAKE,INT_MAX,NULL,NULL,0)==0);
    for(int i=0;i<4;i++){int status=0;CHECK(waitpid(children[i],&status,0)==children[i]);CHECK(WIFEXITED(status)&&WEXITSTATUS(status)==0);}
    first->word=1;errno=0;
    CHECK(klj_futex(&alias->word,WAIT,0,NULL,NULL,0)==-1&&errno==EAGAIN);
    struct timespec timeout={0,2000000};errno=0;
    CHECK(klj_futex(&alias->word,WAIT,1,&timeout,NULL,0)==-1&&errno==ETIMEDOUT);
    struct timespec absolute;CHECK(clock_gettime(CLOCK_REALTIME,&absolute)==0);errno=0;
    CHECK(klj_futex(&first->word,WAIT_BITSET|REALTIME,1,&absolute,NULL,UINT32_MAX)==-1&&errno==ETIMEDOUT);
    errno=0;CHECK(klj_futex(&first->word,WAIT_BITSET,1,NULL,NULL,1)==-1&&errno==ENOSYS);
    errno=0;CHECK(klj_futex(&first->word,WAKE_BITSET,1,NULL,NULL,1)==-1&&errno==ENOSYS);
    errno=0;CHECK(klj_futex(&first->word,REQUEUE,0,(void*)1,&first->other,0)==-1&&errno==ENOSYS);
    uint32_t add=(1u<<28)|(2u<<12);CHECK(klj_futex(&first->word,WAKE_OP,0,NULL,&alias->other,add)==0);CHECK(first->other==2);
    // A private operation on shared storage still retains selective bitsets.
    Group group={0};Waiter private;first->word=0;
    start(&private,&group,&first->word,WAIT_BITSET,1);wait_count(&group.ready,1);
    CHECK(klj_futex(&alias->word,WAKE,INT_MAX,NULL,NULL,0)==0);
    wake_one(&group,&first->word,WAKE_BITSET,1);join(&private);
    CHECK(munmap(first,length)==0);CHECK(munmap(alias,length)==0);
}
int main(void){
    find_collision();collisions();bitsets();timeouts();requeue();wake_operation();cancellation();shared_processes();
    puts("PASS native futex exact-address wake, bitsets, timeout, requeue, wake-op and cancellation");
    puts("PASS shared futex aliases, fork, exact wake count, private isolation and timeout");
    return 0;
}
