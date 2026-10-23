#include <assert.h>
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <arpa/inet.h>
#include "network-policy.h"
static int (*kl_getaddrinfo)(const char *,const char *,const void *,void *);
static bool (*host_allowed)(const char *);
bool klj_network_host_allowed(const char *name){return host_allowed(name);}
#include "native-resolver-imports.h"

int main(int argc,char **argv){
    assert(argc==2);void *library=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!library){puts(dlerror());return 1;}
    void *(*upstream)(const char *)=dlsym(library,"kl_upstream_shim_lookup");assert(upstream);
    kl_getaddrinfo=upstream("getaddrinfo");host_allowed=dlsym(library,"klj_network_host_allowed");assert(kl_getaddrinfo&&host_allowed);
    int (*reverse)(const struct sockaddr *,socklen_t,char *,size_t,char *,size_t,int)=klj_resolver_lookup("getnameinfo");assert(reverse);
    int (*parse)(int,const char *,void *)=klj_resolver_lookup("inet_pton");
    const char *(*format)(int,const void *,char *,socklen_t)=klj_resolver_lookup("inet_ntop");assert(parse&&format);
    for(int family=2;family<=10;family+=8){
        const char *literal=family==2?"127.0.0.1":"::1";
        unsigned char packed[16]={0};char formatted[INET6_ADDRSTRLEN];
        assert(parse(family,literal,packed)==1);
        assert(format(family,packed,formatted,sizeof formatted)==formatted&&!strcmp(formatted,literal));
        assert(parse(family,"not an IP address",packed)==0);
        assert(!format(family,packed,formatted,1)&&errno==ENOSPC);
        struct addrinfo hints={.ai_family=family,.ai_socktype=SOCK_STREAM,.ai_flags=4|8},*addresses=NULL;
        assert(!klj_filtered_getaddrinfo(literal,"443",&hints,&addresses)&&addresses);
        for(struct addrinfo *at=addresses;at;at=at->ai_next){
            char host[NI_MAXHOST],service[NI_MAXSERV];struct sockaddr_storage before={0};
            assert(at->ai_addrlen<=sizeof before);memcpy(&before,at->ai_addr,at->ai_addrlen);
            assert(at->ai_family==family&&*(uint16_t *)at->ai_addr==family);
            // The old direct-Darwin path rejected the very addresses returned
            // by Android getaddrinfo, including when no PTR record is required.
            assert(getnameinfo(at->ai_addr,at->ai_addrlen,host,sizeof host,NULL,0,0)==EAI_FAMILY);
            assert(!reverse(at->ai_addr,at->ai_addrlen,host,sizeof host,service,sizeof service,2|8));
            assert(!strcmp(host,literal)&&!strcmp(service,"443"));
            assert(!reverse(at->ai_addr,at->ai_addrlen,host,sizeof host,NULL,0,0)&&host[0]);
            assert(!reverse(at->ai_addr,at->ai_addrlen,NULL,0,service,sizeof service,8|16)&&!strcmp(service,"443"));
            assert(reverse(at->ai_addr,at->ai_addrlen,host,1,NULL,0,2)==EAI_OVERFLOW);
            assert(reverse(at->ai_addr,at->ai_addrlen-1,host,sizeof host,NULL,0,2)==EAI_FAMILY);
            assert(reverse(at->ai_addr,at->ai_addrlen,host,sizeof host,NULL,0,0x4000)==EAI_BADFLAGS);
            assert(!memcmp(&before,at->ai_addr,at->ai_addrlen));
        }
        freeaddrinfo(addresses);
    }
    assert(reverse(NULL,0,NULL,0,NULL,0,0)==EAI_FAMILY);
    char invalid[16];assert(parse(30,"::1",invalid)==-1&&errno==EAFNOSUPPORT);
    assert(!format(30,invalid,invalid,sizeof invalid)&&errno==EAFNOSUPPORT);
    puts("PASS Android IPv4/IPv6 forward and reverse lookup, service flags, buffer errors and borrowed address preservation");
}
