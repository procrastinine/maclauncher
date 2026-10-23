#include <assert.h>
#include <netdb.h>
#include <stdio.h>
#include <string.h>
#include "network-policy.h"
static int forwarded;
static int kl_getaddrinfo(const char *name,const char *service,const void *hints,void *result){
    forwarded++;return getaddrinfo(name,service,hints,result);
}
#include "native-resolver-imports.h"
int main(int argc,char **argv){
    bool allowed=argc==2&&!strcmp(argv[1],"allow");
    assert(klj_network_configure_ads(allowed));assert(klj_network_configure_ads(allowed));
    assert(!klj_network_configure_ads(!allowed));
    size_t count;const char *const *hosts=klj_network_ad_hosts(&count);assert(count>0);
    for(size_t i=0;i<count;i++){
        assert(klj_network_host_allowed(hosts[i])==allowed);
        char sub[512];snprintf(sub,sizeof sub,"child.%s.",hosts[i]);assert(klj_network_host_allowed(sub)==allowed);
    }
    assert(klj_network_host_allowed("example.com"));assert(klj_network_host_allowed("doubleclick.net.evil.example"));
    assert(klj_network_host_allowed("notdoubleclick.net"));assert(klj_network_host_allowed("googleapis.com"));
    assert(klj_network_host_allowed("xn--bcher-kva.example"));assert(klj_network_host_allowed("127.0.0.1"));
    assert(klj_network_host_allowed("G.AD.DOUBLECLICK.NET.")==allowed);
    if(!allowed){
        void *answer=(void *)1;
        assert(klj_filtered_getaddrinfo("ads.doubleclick.net",NULL,NULL,&answer)==EAI_NONAME);
        assert(answer==NULL&&forwarded==0);
        assert(klj_android_getaddrinfofornet("ads.doubleclick.net",NULL,NULL,0,0,&answer)==EAI_NONAME);
        assert(forwarded==0);
        assert(klj_gethostbyname("ads.doubleclick.net")==NULL&&*klj_get_h_errno()==HOST_NOT_FOUND);
    }
    struct addrinfo hints={.ai_family=AF_INET,.ai_flags=AI_NUMERICHOST},*answer=NULL;
    assert(klj_filtered_getaddrinfo("127.0.0.1",NULL,&hints,&answer)==0&&answer&&forwarded==1);freeaddrinfo(answer);
    hints.ai_family=10;hints.ai_flags=4|8;hints.ai_socktype=SOCK_STREAM;answer=NULL;
    assert(klj_filtered_getaddrinfo("::1","443",&hints,&answer)==0&&answer);
    for(struct addrinfo *at=answer;at;at=at->ai_next){
        assert(at->ai_family==10&&at->ai_socktype==SOCK_STREAM);
        assert((at->ai_flags&AI_NUMERICSERV)==0);
    }
    freeaddrinfo(answer);answer=NULL;
    assert(hints.ai_family==10&&hints.ai_flags==(4|8));
    assert(klj_filtered_getaddrinfo("::1","https",&hints,&answer)==EAI_NONAME&&answer==NULL);
    hints.ai_family=0;hints.ai_flags=4;
    assert(klj_filtered_getaddrinfo("::1",NULL,&hints,&answer)==0&&answer&&answer->ai_family==10);freeaddrinfo(answer);
    hints.ai_family=30;answer=(void *)1;
    assert(klj_filtered_getaddrinfo("::1",NULL,&hints,&answer)==EAI_FAMILY&&answer==NULL);
    hints.ai_family=10;hints.ai_flags=0x1000;answer=(void *)1;
    assert(klj_filtered_getaddrinfo("::1",NULL,&hints,&answer)==EAI_BADFLAGS&&answer==NULL);
    puts("PASS shared host policy and native DNS dispatch");
}
