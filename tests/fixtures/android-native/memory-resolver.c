#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <pthread.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>
// Declared by the enclosing import unit in production; this fixture has no upstream shim or errno translation.
void *kl_upstream_shim_lookup(const char *name);
int kl_errno_to_linux(int value);
#include "native-memory-imports.h"
// Declared by the enclosing Klepton socket unit in production. This fixture
// exercises legacy hostent calls, not that separate addrinfo conversion.
extern int kl_getaddrinfo(const char *,const char *,const void *,void *);
#include "native-resolver-imports.h"
// Isolate the resolver storage check to numeric loopback names. Policy and
// network-service initialization have their own integration coverage.
bool klj_network_host_allowed(const char *name){
    assert(name&&(!strcmp(name,"127.0.0.1")||!strcmp(name,"::1")));return true;
}
static void *other_thread(void *unused){
    (void)unused;assert(*klj_get_h_errno()==0);*klj_get_h_errno()=TRY_AGAIN;
    struct hostent *host=klj_gethostbyname2("::1",10);assert(host&&host->h_addrtype==10&&host->h_length==16);
    struct in6_addr expected=IN6ADDR_LOOPBACK_INIT;assert(!memcmp(host->h_addr_list[0],&expected,16));return NULL;
}
static void shared_alias(size_t page){
    char filename[1024];snprintf(filename,sizeof filename,"%s/android-memory-alias-XXXXXX",getenv("TMPDIR")?getenv("TMPDIR"):"/tmp");int file=mkstemp(filename);
    assert(file>=0&&!unlink(filename)&&!ftruncate(file,page*3));
    unsigned char *source=mmap(NULL,page*2,PROT_READ|PROT_WRITE,MAP_SHARED,file,page);
    assert(source!=MAP_FAILED);source[0]=37;source[page]=52;
    errno=0;assert(klj_mremap(source,0,page,0)==MAP_FAILED&&errno==EINVAL);
    unsigned char *alias=klj_mremap(source,0,page*2,1);
    assert(alias!=MAP_FAILED&&alias!=source&&alias[0]==37&&alias[page]==52);
    alias[page]=73;assert(source[page]==73);
    unsigned char value=0;assert(pread(file,&value,1,page*2)==1&&value==73);
    pid_t child=fork();assert(child>=0);
    if(!child){alias[0]=89;_exit(0);}
    int status;assert(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)==0);
    assert(source[0]==89&&!close(file));
    assert(!mprotect(source,page*2,PROT_READ));
    unsigned char *readonly=klj_mremap(source,0,page,1);assert(readonly!=MAP_FAILED&&readonly[0]==89);
    mach_vm_address_t base=(uintptr_t)readonly;mach_vm_size_t size=0;mach_port_t object=MACH_PORT_NULL;
    vm_region_basic_info_data_64_t info;mach_msg_type_number_t count=VM_REGION_BASIC_INFO_COUNT_64;
    assert(mach_vm_region(mach_task_self(),&base,&size,VM_REGION_BASIC_INFO_64,(vm_region_info_t)&info,&count,&object)==KERN_SUCCESS);
    if(object!=MACH_PORT_NULL)assert(!mach_port_deallocate(mach_task_self(),object));
    assert(info.protection==VM_PROT_READ&&info.inheritance==VM_INHERIT_SHARE);
    assert(!munmap(source,page*2));alias[0]=97;assert(readonly[0]==97);
    assert(!munmap(alias,page*2)&&!munmap(readonly,page));
    source=mmap(NULL,page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(source!=MAP_FAILED);
    errno=0;assert(klj_mremap(source,0,page,1)==MAP_FAILED&&errno==EINVAL);assert(!munmap(source,page));
    puts("PASS shared mremap backing offset, alias lifetime, protections and fork visibility");
}
static void many_regions(size_t page){
    const size_t regions=1030,length=page*regions;mach_vm_address_t base=0;
    assert(!mach_vm_allocate(mach_task_self(),&base,length,VM_FLAGS_ANYWHERE));
    // Distinct tags prevent Darwin from coalescing the adjacent compatible
    // anonymous regions; this is still one ordinary guest remap range.
    for(size_t i=0;i<regions;i++){
        mach_vm_address_t at=base+i*page;
        assert(!mach_vm_allocate(mach_task_self(),&at,page,VM_FLAGS_FIXED|VM_FLAGS_OVERWRITE|VM_MAKE_TAG(240+(i&1))));
        *(unsigned char *)(uintptr_t)at=(unsigned char)i;
    }
    mach_vm_address_t cursor=base;size_t observed=0;
    while(cursor<base+length){
        mach_vm_address_t at=cursor;mach_vm_size_t size=0;natural_t depth=0;
        vm_region_submap_info_data_64_t info;mach_msg_type_number_t count=VM_REGION_SUBMAP_INFO_COUNT_64;
        assert(!mach_vm_region_recurse(mach_task_self(),&at,&size,&depth,(vm_region_recurse_info_t)&info,&count));
        assert(at==cursor&&size);cursor+=size;++observed;
    }
    assert(observed>1024);
    void *address=(void *)(uintptr_t)base;assert(klj_mremap(address,length,page,0)==address);
    assert(!munmap(address,page));
}
static void mapping_status(size_t page){
    char filename[1024];snprintf(filename,sizeof filename,"%s/android-memory-sync-XXXXXX",getenv("TMPDIR")?getenv("TMPDIR"):"/tmp");int file=mkstemp(filename);
    assert(file>=0&&!unlink(filename)&&!ftruncate(file,page*2));
    unsigned char *view=mmap(NULL,page*2,PROT_READ|PROT_WRITE,MAP_SHARED,file,0);
    assert(view!=MAP_FAILED);view[0]=47;view[page]=83;
    for(int flags=0;flags<=6;flags++)if(flags!=5)assert(!klj_msync(view,page+1,flags));
    unsigned char byte=0;assert(pread(file,&byte,1,page)==1&&byte==83);
    unsigned char residency[3]={0xff,0xff,0x6b};
    assert(!klj_mincore(view,page+1,residency));
    assert(residency[0]<=1&&residency[1]<=1&&residency[2]==0x6b);
    errno=0;assert(klj_msync(view,page,5)==-1&&errno==EINVAL);
    errno=0;assert(klj_msync(view,page,8)==-1&&errno==EINVAL);
    errno=0;assert(klj_msync(view+1,0,0)==-1&&errno==EINVAL);
    errno=0;assert(klj_mincore(view+1,0,residency)==-1&&errno==EINVAL);
    errno=0;assert(klj_msync(view,SIZE_MAX,4)==-1&&errno==ENOMEM);
    errno=0;assert(klj_mincore(view,SIZE_MAX,residency)==-1&&errno==ENOMEM);
    assert(!klj_msync(view,0,0)&&!klj_mincore(view,0,NULL));
    assert(!munmap(view,page*2));
    errno=0;assert(klj_mincore(view,page,residency)==-1&&errno==ENOMEM);
    assert(!close(file));
    puts("PASS shared Linux msync flags, mapped-file writeback and mincore residency ABI");
}
int main(void){
    size_t page=vm_page_size;
    mapping_status(page);
    shared_alias(page);
    many_regions(page);
    unsigned char *source=mmap(NULL,page*3,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(source!=MAP_FAILED);
    source[0]=17;source[page-1]=33;source[page*2]=91;
    errno=0;assert(klj_mremap(source,page,page*2,0)==MAP_FAILED&&errno==ENOMEM);assert(source[page*2]==91);
    unsigned char *moved=klj_mremap(source,page,page*2,1);assert(moved!=MAP_FAILED&&moved!=source);
    assert(moved[0]==17&&moved[page-1]==33&&moved[page]==0&&source[page*2]==91);
    mach_vm_address_t query=(uintptr_t)source;mach_vm_size_t extent=0;natural_t depth=0;
    vm_region_submap_info_data_64_t info;mach_msg_type_number_t count=VM_REGION_SUBMAP_INFO_COUNT_64;
    assert(mach_vm_region_recurse(mach_task_self(),&query,&extent,&depth,(vm_region_recurse_info_t)&info,&count)==KERN_SUCCESS&&query>(uintptr_t)source);
    assert(klj_mremap(moved,page*2,page,0)==moved);assert(moved[0]==17);assert(munmap(moved,page)==0);assert(munmap(source+page,page*2)==0);
    source=mmap(NULL,page*3,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(source!=MAP_FAILED);source[0]=55;
    assert(munmap(source+page,page*2)==0);assert(klj_mremap(source,page,page*2,0)==source);assert(source[0]==55&&source[page]==0);
    assert(mprotect(source,page*2,PROT_READ)==0);assert(klj_mremap(source,page*2,page,0)==source);
    errno=0;assert(klj_mremap(source+1,page,page,0)==MAP_FAILED&&errno==EINVAL);
    errno=0;assert(klj_mremap(source,page,page*2,3,(void *)source)==MAP_FAILED&&errno==ENOTSUP);assert(source[0]==55);
    errno=0;assert(klj_mremap(source,page,SIZE_MAX,1)==MAP_FAILED&&errno==ENOMEM);
    assert(munmap(source,page)==0);
    source=mmap(NULL,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);assert(source!=MAP_FAILED);source[0]=61;source[page]=92;
    assert(!mprotect(source,page,PROT_READ));moved=klj_mremap(source,page,page*2,1);assert(moved!=MAP_FAILED&&moved[0]==61&&moved[page]==0);
    query=(uintptr_t)moved+page;count=VM_REGION_SUBMAP_INFO_COUNT_64;depth=0;
    assert(mach_vm_region_recurse(mach_task_self(),&query,&extent,&depth,(vm_region_recurse_info_t)&info,&count)==KERN_SUCCESS&&info.protection==VM_PROT_READ);
    assert(!munmap(moved,page*2)&&!munmap(source+page,page));
    struct hostent *host=klj_gethostbyname("127.0.0.1");assert(host&&host->h_addrtype==2&&host->h_length==4);
    unsigned char ip[4]={127,0,0,1};assert(!memcmp(host->h_addr_list[0],ip,4));
    *klj_get_h_errno()=NO_RECOVERY;pthread_t child;assert(!pthread_create(&child,NULL,other_thread,NULL));assert(!pthread_join(child,NULL));
    assert(*klj_get_h_errno()==NO_RECOVERY);assert(!memcmp(host->h_addr_list[0],ip,4));
    errno=0;assert(!klj_gethostbyname2("127.0.0.1",999)&&errno==EAFNOSUPPORT&&*klj_get_h_errno()==NETDB_INTERNAL);
    puts("PASS Mach remap data/neighbor/protection ownership and thread-local real resolver");
}
