#include PROCESS_IDS_SOURCE
#include <assert.h>

static unsigned opened;
static void *enter(void){return NULL;}
static int adopt(int fd){opened++;return fd;}
static void closed(int fd){(void)fd;}
static void leave(void *scope){(void)scope;}
static const KljProcessDescriptors descriptors={enter,adopt,closed,leave};
typedef struct {pid_t host;int id,channel;} Child;
static Child start(const char *directory,unsigned next){
    int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));
    pid_t host=fork();assert(host>=0);
    if(!host){
        close(pair[0]);cursor=next;int id=klj_process_ids_configure(directory);assert(id>0);
        assert(write(pair[1],&id,sizeof id)==sizeof id);char command;
        while(read(pair[1],&command,1)==1){if(command=='q')break;
            assert(command=='p');int parent=klj_process_id_from_host(getppid());
            assert(write(pair[1],&parent,sizeof parent)==sizeof parent);
        }
        close(pair[1]);_exit(0);
    }
    close(pair[1]);Child child={host,0,pair[0]};assert(read(child.channel,&child.id,sizeof child.id)==sizeof child.id);return child;
}
static void stop(Child child){assert(write(child.channel,"q",1)==1);close(child.channel);int status;assert(waitpid(child.host,&status,0)==child.host&&WIFEXITED(status)&&WEXITSTATUS(status)==0);}
static void index_path(char *path,size_t size,const char *directory,pid_t host){snprintf(path,size,"%s/by-host/%d",directory,host);}
int main(int argc,char **argv){
    assert(argc==2);const char *directory=argv[1];
    // Original historical lease inodes are deliberately stable. Populate them
    // using the production record definition, with no fabricated live locks.
    for(unsigned id=2;id<4098;id++){
        char path[4096];snprintf(path,sizeof path,"%s/%u",directory,id);
        int fd=open(path,O_RDWR|O_CREAT|O_EXCL,0600);assert(fd>=0);
        Lease retired={.version=3,.kind=2,.process_id=2,.uid=-1};assert(!write_record(fd,&retired));close(fd);
    }
    int self=klj_process_ids_configure(directory);assert(self>0);
    Child a=start(directory,50000),b=start(directory,50010);
    assert(!klj_process_descriptors_owned(&descriptors));
    struct timespec begin,end;clock_gettime(CLOCK_MONOTONIC,&begin);opened=0;
    for(unsigned i=0;i<100;i++){assert(klj_process_id_from_host(a.host)==a.id);assert(klj_process_id_from_host(b.host)==b.id);}
    clock_gettime(CLOCK_MONOTONIC,&end);unsigned fast=opened;
    assert(fast<=400);assert(klj_process_id_from_host(getpid())==self);
    char path[4096];index_path(path,sizeof path,directory,b.host);assert(!unlink(path));
    // An older live owner is discovered once by the original directory scan.
    opened=0;assert(klj_process_id_from_host(b.host)==b.id);unsigned legacy=opened;assert(legacy>2);
    opened=0;assert(klj_process_id_from_host(b.host)==b.id&&opened<=2);
    // A reused/stale physical name cannot authenticate another lease. Point
    // it at this process to also prove that validation does not close an alias
    // descriptor and accidentally release this process's POSIX kernel lock.
    lock_ids();index_process_locked(self,b.host);unlock_ids();
    assert(klj_process_id_from_host(b.host)==b.id);
    assert(write(b.channel,"p",1)==1);int observed;assert(read(b.channel,&observed,sizeof observed)==sizeof observed&&observed==self);
    opened=0;assert(klj_process_id_from_host(b.host)==b.id&&opened<=2);
    stop(a);assert(klj_process_id_from_host(a.host)<0&&errno==ESRCH);
    // Slot reuse retires only its former reverse name; live peer B remains.
    cursor=(unsigned)a.id;int thread=klj_thread_id_allocate();assert(thread==a.id);
    index_path(path,sizeof path,directory,a.host);char target[32];assert(readlink(path,target,sizeof target)<0&&errno==ENOENT);
    assert(klj_process_id_from_host(b.host)==b.id);klj_thread_id_release(thread);stop(b);
    assert(klj_process_id_from_host(b.host)<0&&errno==ESRCH);
    printf("PASS indexed live lease lookup: 4096 historical records, 200 lookups, %u opens, %.3f ms; legacy %u opens; stale PID, owned locks and slot retirement\n",fast,(end.tv_sec-begin.tv_sec)*1000.0+(end.tv_nsec-begin.tv_nsec)/1e6,legacy);
    return 0;
}
