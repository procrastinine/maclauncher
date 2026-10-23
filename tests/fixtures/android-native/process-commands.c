#include PROCESS_IDS_SOURCE
#include <assert.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <sys/wait.h>

static unsigned opened;
static void *enter(void){return NULL;}
static int adopt(int fd){opened++;return fd;}
static void closed(int fd){(void)fd;}
static void leave(void *scope){(void)scope;}
static const KljProcessDescriptors descriptors={enter,adopt,closed,leave};
typedef struct {pid_t pid;int descriptor;} Broker;
static int exact(int fd,void *bytes,size_t size,int writing){
    size_t at=0;while(at<size){ssize_t n=writing?write(fd,(char*)bytes+at,size-at):read(fd,(char*)bytes+at,size-at);if(n<0&&errno==EINTR)continue;if(n<=0)return -1;at+=(size_t)n;}return 0;
}
static Broker broker(const char *directory){
    const char *helper=getenv("ANDROID_PROCESS_QUERY_HELPER");assert(helper);
    int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));pid_t pid=fork();assert(pid>=0);
    if(!pid){
        close(pair[0]);if(directory_fd>=0){close(directory_fd);directory_fd=-1;}
        unsigned char operation;
        while(!exact(pair[1],&operation,1,0)){
            assert(operation==1);int output[2];assert(!pipe(output));pid_t child=fork();assert(child>=0);
            if(!child){close(output[0]);assert(dup2(output[1],1)==1);close(output[1]);execl(helper,helper,"--namespace-processes",directory,(char*)0);_exit(127);}
            close(output[1]);char bytes[65536];size_t at=0;ssize_t n;
            while((n=read(output[0],bytes+at,sizeof bytes-1-at))>0)at+=(size_t)n;
            close(output[0]);bytes[at]=0;int status;assert(waitpid(child,&status,0)==child);
            uint32_t hosts[4096],count=0;char *cursor=strchr(bytes,'[');
            if(!WIFEXITED(status)||WEXITSTATUS(status)||!cursor)count=UINT32_MAX;
            else {cursor++;while(*cursor&&*cursor!=']'){char *end;long host=strtol(cursor,&end,10);assert(end!=cursor&&host>0&&host<=INT32_MAX&&count<4096);hosts[count++]=htonl((uint32_t)host);cursor=*end==','?end+1:end;}}
            uint32_t header=htonl(count);if(exact(pair[1],&header,sizeof header,1)||(count!=UINT32_MAX&&exact(pair[1],hosts,(size_t)count*sizeof *hosts,1)))break;
        }
        close(pair[1]);_exit(0);
    }
    close(pair[1]);return(Broker){pid,pair[0]};
}
static void stop_broker(Broker value){close(value.descriptor);int status;assert(waitpid(value.pid,&status,0)==value.pid&&WIFEXITED(status)&&!WEXITSTATUS(status));}

static void lookup(const char *name,int expected){
    int *pids=NULL;size_t length=0;
    assert(!klj_process_find_commands(&name,1,&pids,&length));
    assert(length==(expected>0?1u:0u));
    if(expected>0)assert(pids[0]==expected);
    free(pids);
}
static void sandbox_lookup(const char *executable,const char *directory,int id){
    Broker owner=broker(directory);
    pid_t query=fork();assert(query>=0);
    if(!query){char expected[16],descriptor[16];snprintf(expected,sizeof expected,"%d",id);snprintf(descriptor,sizeof descriptor,"%d",owner.descriptor);setenv("KL_ANDROID_PROCESS_QUERY_FD",descriptor,1);execl("/usr/bin/sandbox-exec","sandbox-exec","-p","(version 1)(allow default)(deny process-info*)(allow process-info* (target self))",executable,directory,"sandbox",expected,(char*)0);_exit(127);}
    int status;assert(waitpid(query,&status,0)==query&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    stop_broker(owner);
}
int main(int argc,char **argv){
    if(argc==2&&!strcmp(argv[1],"--deadline")){
        int pair[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,pair));unsigned char bytes[4]={0};assert(write(pair[0],bytes,2)==2);
        uint64_t began=query_now(),deadline=began+100000000u;assert(!query_transfer(pair[1],bytes,1,0,deadline));usleep(60000);
        assert(query_transfer(pair[1],bytes,2,0,deadline)<0&&errno==ETIMEDOUT);uint64_t elapsed=query_now()-began;assert(elapsed>=90000000u&&elapsed<1000000000u);
        close(pair[0]);close(pair[1]);puts("PASS partial process-query frames share one absolute deadline");return 0;
    }
    if(argc==4){
        assert(klj_process_ids_configure(argv[1])>0);int id=atoi(argv[3]);pid_t host;int kind,process;assert(!klj_process_id_query(id,&host,&kind,&process));
        pid_t *hosts=NULL;size_t length=0;int available=!command_hosts(&hosts,&length),seen=0;
        for(size_t i=0;i<length;i++)if(hosts[i]==host)seen=1;free(hosts);
        assert(available&&seen);assert(!klj_process_descriptors_owned(&descriptors));opened=0;lookup("owned.child",id);
        printf("PASS sandboxed command discovery retains namespace peer:kernel snapshot%d,peer%d,%u opens\n",available,seen,opened);return 0;
    }
    assert(argc==2);const char *directory=argv[1];Broker owner=broker(directory);char descriptor[16];snprintf(descriptor,sizeof descriptor,"%d",owner.descriptor);setenv("KL_ANDROID_PROCESS_QUERY_FD",descriptor,1);
    int self=klj_process_ids_configure(directory);assert(self>0);
    assert(!klj_process_publish_principal(1000));
    assert(!klj_process_publish_name("owned.command --argument"));lookup("owned.command",self);
    assert(!klj_process_publish_name("owned.renamed"));lookup("owned.command",0);lookup("owned.renamed",self);
    int channel[2];assert(!socketpair(AF_UNIX,SOCK_STREAM,0,channel));pid_t child=fork();assert(child>=0);
    if(!child){
        close(channel[0]);int id=klj_process_id();assert(id>0&&id!=self);
        assert(!klj_process_publish_name("owned.child"));assert(write(channel[1],&id,sizeof id)==sizeof id);
        char command;while(read(channel[1],&command,1)==1){
            if(command=='q')_exit(0);
            int result=command=='p'?klj_process_id_from_host(getppid()):klj_process_publish_name("owned.child.renamed");
            assert(write(channel[1],&result,sizeof result)==sizeof result);
        }
        _exit(0);
    }
    close(channel[1]);int id=0;assert(read(channel[0],&id,sizeof id)==sizeof id);
    assert(!klj_process_descriptors_owned(&descriptors));opened=0;
    struct timespec begin,end;clock_gettime(CLOCK_MONOTONIC,&begin);lookup("owned.child",id);clock_gettime(CLOCK_MONOTONIC,&end);
    unsigned before=opened;double without=(end.tv_sec-begin.tv_sec)*1000.0+(end.tv_nsec-begin.tv_nsec)/1e6;
    for(unsigned value=2,created=0;created<4096;value++){
        if(value==(unsigned)self||value==(unsigned)id)continue;
        char path[PATH_MAX];snprintf(path,sizeof path,"%s/%u",directory,value);
        int fd=open(path,O_RDWR|O_CREAT|O_EXCL,0600);assert(fd>=0);
        Lease retired={.version=3,.kind=2,.process_id=2,.uid=-1};assert(!write_record(fd,&retired));close(fd);created++;
    }
    sandbox_lookup(argv[0],directory,id);
    opened=0;clock_gettime(CLOCK_MONOTONIC,&begin);lookup("owned.child",id);clock_gettime(CLOCK_MONOTONIC,&end);
    unsigned fast=opened;double with=(end.tv_sec-begin.tv_sec)*1000.0+(end.tv_nsec-begin.tv_nsec)/1e6;assert(fast==before&&fast<=6);
    opened=0;clock_gettime(CLOCK_MONOTONIC,&begin);for(unsigned i=0;i<5;i++)lookup("owned.child",id);clock_gettime(CLOCK_MONOTONIC,&end);
    double repeated=(end.tv_sec-begin.tv_sec)*1000.0+(end.tv_nsec-begin.tv_nsec)/1e6;assert(opened==fast*5);
    lookup("missing.command",0);
    char index[PATH_MAX];snprintf(index,sizeof index,"%s/by-host/%d",directory,child);assert(!unlink(index));
    sandbox_lookup(argv[0],directory,id);assert(!unlink(index));
    opened=0;lookup("owned.child",id);unsigned legacy=opened;assert(legacy>fast);
    opened=0;lookup("owned.child",id);assert(opened<=6);
    lock_ids();index_process_locked(self,child);unlock_ids();lookup("owned.child",id);
    assert(write(channel[0],"p",1)==1);int observed;assert(read(channel[0],&observed,sizeof observed)==sizeof observed&&observed==self);
    assert(write(channel[0],"r",1)==1);assert(read(channel[0],&observed,sizeof observed)==sizeof observed&&observed==0);
    lookup("owned.child",0);lookup("owned.child.renamed",id);
    assert(write(channel[0],"q",1)==1);close(channel[0]);int status;assert(waitpid(child,&status,0)==child);lookup("owned.child.renamed",0);
    close(process_query_fd);process_query_fd=-1;stop_broker(owner);
    lookup("owned.renamed",self); // A retired broker retains the complete compatibility fallback.
    printf("PASS command queries retain live logical leases and retire old names:4096 historical records,%u opens before/after;%.3f/%.3f ms without/with history;5 queries %.3f ms;legacy repair%u opens,renamed/live peer/stale index/owned locks\n",fast,without,with,repeated,legacy);
}
