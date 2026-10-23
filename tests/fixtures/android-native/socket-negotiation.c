/* Reuse the descriptor fixture's ancillary helpers and unrelated service
 * link boundaries; all socket ownership and negotiation below are real. */
#define main descriptor_fixture_main
#define kl_errno_to_linux unrelated_errno_to_linux
#include "directory-descriptors.c"
#undef kl_errno_to_linux
#undef main
#include "original-errno.h"
#include "socket-capability.h"
#include "socket-identity.h"
#include "process-ids.h"
#include "network-services/bpf/socket.h"
int klj_bpf_socket_created(int fd,int domain,int type,int protocol){(void)fd;(void)domain;(void)type;(void)protocol;abort();}
int klj_security_socket_created(int fd,int domain,int type,int protocol){(void)fd;(void)domain;(void)type;(void)protocol;abort();}
int klj_bpf_socket_address(int fd,int operation,struct sockaddr_storage *address,socklen_t *size){(void)fd;(void)operation;(void)address;(void)size;abort();}
int klj_bpf_socket_accepted(int listener,int accepted){struct sockaddr_storage address;socklen_t size=sizeof address;(void)listener;assert(!getsockname(accepted,(void*)&address,&size)&&address.ss_family==AF_UNIX);return 0;}

int klj_socket_authority_request(const char *action,int fd,int storage,uint64_t cookie,const char *target){
    char own[256]={0};if(storage>=0){ssize_t size=klj_socket_storage_context(storage,own,sizeof own);assert(size>=0||errno==ENODATA);}
    struct socket_info actual;assert(!klj_socket_identity(getpid(),fd,cookie,&actual));
    printf("{\"action\":\"%s\",\"fd\":%d,\"cookie\":\"%016llx\",\"target\":\"%s\",\"label\":%s%s%s}\n",action,fd,(unsigned long long)cookie,target?target:"",*own?"\"":"null",own,*own?"\"":"");fflush(stdout);
    if(!strcmp(action,"retire"))return 0;
    char response[512],peer[256];int result;assert(fgets(response,sizeof response,stdin)&&sscanf(response,"%d %255s",&result,peer)==2);if(strcmp(peer,"-"))assert(!klj_socket_storage_peer_label(storage,peer));return result;
}
static void barrier(void){puts("{\"barrier\":true}");fflush(stdout);char response[32];assert(fgets(response,sizeof response,stdin)&&atoi(response)==0);}
static int listener(struct sockaddr_un *address,int owned){
    unlink(address->sun_path);int fd=socket(AF_UNIX,SOCK_STREAM,0);assert(fd>=0&&!bind(fd,(void*)address,sizeof *address));
    if(owned)assert(!klj_descriptor_socket_label(fd,"u:r:system_server:s0"));
    assert(!(owned?klj_socket_listen(fd,4):listen(fd,4)));return fd;
}
int main(int argc,char **argv){
    assert(argc==3&&klj_process_ids_configure(argv[1])>0);
    printf("{\"hello\":%d}\n",klj_process_id());fflush(stdout);char response[32];assert(fgets(response,sizeof response,stdin));
    struct sockaddr_un address={.sun_family=AF_UNIX};assert(strlen(argv[2])<sizeof address.sun_path);strcpy(address.sun_path,argv[2]);
    int server=listener(&address,1),alias=klj_pollable_dup(server);assert(alias>=0&&!klj_pollable_close(server));
    int client=socket(AF_UNIX,SOCK_STREAM,0);assert(client>=0&&!klj_descriptor_socket_label(client,"u:r:untrusted_app:s0")&&!klj_socket_connect(client,(void*)&address,sizeof address));
    char context[256];assert(klj_descriptor_socket_peer_context(client,context,sizeof context)>0&&!strcmp(context,"u:r:system_server:s0"));
    assert(klj_descriptor_protocol(client)==1); // Can send before accept.
    int directory=open(argv[1],O_RDONLY|O_DIRECTORY);assert(directory>=0);send_fd(client,directory);
    int accepted=klj_socket_accept(alias,NULL,NULL);assert(accepted>=0&&klj_descriptor_protocol(accepted)==1);
    assert(klj_descriptor_socket_peer_context(accepted,context,sizeof context)>0&&!strcmp(context,"u:r:untrusted_app:s0"));
    assert(!klj_pollable_close(alias));unlink(address.sun_path);
    int peek=receive_fd(accepted,MSG_PEEK),received=receive_fd(accepted,0);
    assert(klj_pollable_owned(peek)&&klj_pollable_owned(received));klj_pollable_close(peek);klj_pollable_close(received);
    send_fd(accepted,directory);assert(!klj_pollable_close(accepted));
    received=receive_fd(client,MSG_PEEK);assert(klj_pollable_owned(received));klj_pollable_close(received);
    received=receive_fd(client,0);assert(klj_pollable_owned(received));klj_pollable_close(received);
    char byte;assert(klj_descriptor_recv(client,&byte,1,0)==0);
    KljDescriptorTransfer retained;int proof=klj_descriptor_socket_claim(client,&retained);assert(proof>=0);
    assert(!klj_pollable_close(client)&&fcntl(proof,F_GETFD)>=0);klj_descriptor_export_release(&retained);assert(fcntl(proof,F_GETFD)<0);
    klj_pollable_close(directory);barrier();

    // An unnegotiated native client still sends ordinary SCM_RIGHTS.
    server=listener(&address,1);client=socket(AF_UNIX,SOCK_STREAM,0);assert(client>=0&&!connect(client,(void*)&address,sizeof address));
    accepted=klj_socket_accept(server,NULL,NULL);assert(accepted>=0&&!klj_descriptor_protocol(accepted));
    int plain=open("/dev/null",O_RDONLY);assert(plain>=0);send_fd(client,plain);received=receive_fd(accepted,0);assert(!klj_pollable_owned(received));
    klj_pollable_close(received);close(plain);close(client);klj_pollable_close(accepted);klj_pollable_close(server);barrier();

    // An owned client also leaves an ordinary native listener unframed.
    server=listener(&address,0);client=socket(AF_UNIX,SOCK_STREAM,0);assert(client>=0&&!klj_socket_connect(client,(void*)&address,sizeof address));
    accepted=accept(server,NULL,NULL);assert(accepted>=0&&!klj_descriptor_protocol(client));
    assert(klj_descriptor_send(client,"raw",3,0)==3);char data[3];assert(read(accepted,data,3)==3&&!memcmp(data,"raw",3));
    klj_pollable_close(client);close(accepted);close(server);unlink(address.sun_path);barrier();
    puts("{\"done\":true}");fflush(stdout);return 0;
}
