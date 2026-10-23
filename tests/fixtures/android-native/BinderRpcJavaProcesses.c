#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdlib.h>
#include <stdio.h>
#include <signal.h>
#include <errno.h>
/* argv: Java, classpath, runtime, private data. The parent remains the watchdog
 * owner; peer identity is supplied from actual fork PIDs before either exec. */
static void launch(char** args,const char* role,int fd,pid_t peer){
    char descriptor[32],pid[32];snprintf(descriptor,sizeof descriptor,"%d",fd);snprintf(pid,sizeof pid,"%d",peer);
    execl(args[1],args[1],"-Xverify:all","-cp",args[2],args[5]?args[5]:"maclauncher.android.fixture.BinderRpcJavaProbe",role,"unused",args[3],args[4],pid,descriptor,(char*)NULL);perror("exec Java");_exit(127);
}
int main(int argc,char** argv){
    if(argc!=5&&argc!=6)return 2;int pair[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,pair))return 3;
    int identity[2];if(pipe(identity))return 4;
    pid_t server=fork();if(server<0)return 5;
    if(!server){close(pair[0]);close(identity[1]);pid_t client;if(read(identity[0],&client,sizeof client)!=sizeof client)_exit(6);close(identity[0]);launch(argv,"server",pair[1],client);}
    close(identity[0]);pid_t client=fork();if(client<0){kill(server,SIGKILL);return 7;}
    if(!client){close(pair[1]);close(identity[1]);launch(argv,"client",pair[0],server);}
    close(pair[0]);close(pair[1]);if(write(identity[1],&client,sizeof client)!=sizeof client){kill(server,SIGKILL);kill(client,SIGKILL);return 8;}close(identity[1]);
    int first=0,second=0;while(waitpid(client,&first,0)<0&&errno==EINTR){}if(!WIFEXITED(first)||WEXITSTATUS(first))kill(server,SIGKILL);while(waitpid(server,&second,0)<0&&errno==EINTR){}
    return WIFEXITED(first)&&!WEXITSTATUS(first)&&WIFEXITED(second)&&!WEXITSTATUS(second)?0:1;
}
