#include "process-ids.h"
#include <assert.h>
#include <errno.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
static pid_t child;
static void timeout(int signal){(void)signal;if(child>0)kill(child,SIGKILL);_exit(124);}
int main(int argc,char **argv){
    assert(argc>2);
    assert(klj_process_ids_configure(getenv("KL_ANDROID_ID_DIRECTORY"))>=0);
    int32_t logical=klj_process_id();assert(logical>0);
    int pair[2];assert(socketpair(AF_UNIX,SOCK_STREAM,0,pair)==0);
    posix_spawn_file_actions_t actions;assert(posix_spawn_file_actions_init(&actions)==0);
    assert(posix_spawn_file_actions_adddup2(&actions,pair[1],3)==0);
    if(pair[0]!=3)assert(posix_spawn_file_actions_addclose(&actions,pair[0])==0);
    if(pair[1]!=3)assert(posix_spawn_file_actions_addclose(&actions,pair[1])==0);
    assert(posix_spawn(&child,argv[1],&actions,NULL,argv+1,environ)==0);
    posix_spawn_file_actions_destroy(&actions);close(pair[1]);
    signal(SIGALRM,timeout);alarm(30);
    uint32_t expected[4]={(uint32_t)logical,(uint32_t)getpid(),getuid(),getgid()};
    assert(write(pair[0],expected,sizeof expected)==sizeof expected);
    uint32_t accepted=0;assert(read(pair[0],&accepted,sizeof accepted)==sizeof accepted&&accepted==1);
    close(pair[0]);int status=0;assert(waitpid(child,&status,0)==child);
    alarm(0);assert(WIFEXITED(status)&&WEXITSTATUS(status)==0);return 0;
}
