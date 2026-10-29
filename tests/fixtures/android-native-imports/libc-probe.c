#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
#include <poll.h>
// This fixture owns ordinary POSIX sockets. Pollable-descriptor translation
// has its separate native integration test; these delegates use real poll/close.
int klj_pollable_poll(struct pollfd *fds,nfds_t count,int timeout){return poll(fds,count,timeout);}
int klj_pollable_close(int fd){return close(fd);}
// The delegates below use real local sockets/FILEs. Their LP64 guest layout is
// the unchanged Klepton ABI consumed by the production header.
typedef struct {
 void *msg_name; uint32_t msg_namelen,_pad; struct iovec *msg_iov;
 uint64_t msg_iovlen; void *msg_control; uint64_t msg_controllen;
 int32_t msg_flags; uint32_t _pad2;
} kl_lx_msghdr;
static jmp_buf fatal;
static void die(const char *message){assert(strstr(message,"_chk"));longjmp(fatal,1);}
static off_t kl_ftello(void *f){return ftello(f);}
static int kl_fseeko(void *f,off_t offset,int whence){return fseeko(f,offset,whence);}
int klj_directory_fd(void *directory){(void)directory;return -1;}
static size_t kl_fread(void *p,size_t n,size_t c,void *f){return fread(p,n,c,f);}
static int host_flags(int f){return ((f&1)?MSG_OOB:0)|((f&2)?MSG_PEEK:0)|((f&0x40)?MSG_DONTWAIT:0)|((f&0x100)?MSG_WAITALL:0);}
static ssize_t kl_sendto(int fd,const void *p,size_t n,int f,const struct sockaddr *a,socklen_t l){return sendto(fd,p,n,host_flags(f),a,l);}
static ssize_t kl_sendmsg(int fd,const kl_lx_msghdr *m,int f){
 struct msghdr host={.msg_name=m->msg_name,.msg_namelen=m->msg_namelen,.msg_iov=m->msg_iov,.msg_iovlen=(int)m->msg_iovlen};return sendmsg(fd,&host,host_flags(f));
}
static ssize_t kl_recvmsg(int fd,kl_lx_msghdr *m,int f){
 struct msghdr host={.msg_name=m->msg_name,.msg_namelen=m->msg_namelen,.msg_iov=m->msg_iov,.msg_iovlen=(int)m->msg_iovlen,.msg_control=m->msg_control,.msg_controllen=(socklen_t)m->msg_controllen};
 ssize_t n=recvmsg(fd,&host,host_flags(f));if(n>=0){m->msg_namelen=host.msg_namelen;m->msg_controllen=host.msg_controllen;m->msg_flags=(host.msg_flags&MSG_TRUNC)?0x20:0;}return n;
}
// Declared by the enclosing import unit in production; this fixture has no upstream shim or errno translation.
void *kl_upstream_shim_lookup(const char *name);
int kl_errno_to_linux(int value);
void *kl_upstream_shim_lookup(const char *name){(void)name;return NULL;}
int kl_errno_to_linux(int value){return value;}
#include "native-libc-imports.h"
#define REFUSES(call) do {if(!setjmp(fatal)){(void)(call);assert(!"FORTIFY did not reject");}} while(0)
int main(void){
 char *bounded=((char *(*)(const char*,size_t))klj_native_libc_lookup("strndup"))("android",3);assert(bounded&&!strcmp(bounded,"and"));free(bounded);
 uint32_t (*uniform)(uint32_t)=klj_native_libc_lookup("arc4random_uniform");for(unsigned i=0;i<100;i++)assert(uniform(7)<7);assert(uniform(0)==0);
 const char *names[]={"_Exit","iconv_open","iconv_close","iconv","wcscasecmp","wcsncasecmp","__sendto_chk","__fread_chk","__poll_chk","__memchr_chk","sendmmsg","recvmmsg"};
 for(unsigned i=0;i<sizeof(names)/sizeof(*names);++i)assert(klj_native_libc_lookup(names[i]));
 assert(!klj_native_libc_lookup("not_a_libc_import"));
 assert(klj_native_libc_lookup("timezone")==&timezone&&klj_native_libc_lookup("daylight")==&daylight&&klj_native_libc_lookup("tzname")==tzname);
 long *zone=klj_native_libc_lookup("timezone");int *summer=klj_native_libc_lookup("daylight");char **namesOfZone=klj_native_libc_lookup("tzname");
 setenv("TZ","UTC0",1);tzset();assert(*zone==0&&*summer==0&&!strcmp(namesOfZone[0],"UTC"));
 setenv("TZ","EST5EDT,M3.2.0,M11.1.0",1);tzset();assert(*zone==18000&&*summer==1&&!strcmp(namesOfZone[0],"EST")&&!strcmp(namesOfZone[1],"EDT"));
 setenv("TZ","NPT-5:45",1);tzset();assert(*zone==-20700&&*summer==0&&!strcmp(namesOfZone[0],"NPT"));
 void *(*search)(const void*,size_t,const void*,size_t)=klj_native_libc_lookup("memmem");
 assert(search);
 const unsigned char binary[]={1,0,2,0,3,0,2},needle[]={0,2};
 assert(search(binary,sizeof binary,needle,sizeof needle)==binary+1);
 assert(search(binary,sizeof binary,needle,sizeof needle)==memmem(binary,sizeof binary,needle,sizeof needle));
 assert(search(binary,2,needle,sizeof needle)==NULL);
 assert(search(binary,sizeof binary,needle,0)==binary&&search(binary,0,needle,0)==binary);
 assert(search(binary,0,needle,sizeof needle)==NULL&&search(binary,1,needle,sizeof needle)==NULL);
 size_t page=(size_t)getpagesize();unsigned char *guard=mmap(NULL,page*2,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANON,-1,0);
 assert(guard!=MAP_FAILED&&mprotect(guard+page,page,PROT_NONE)==0);
 unsigned char *tail=guard+page-64;memset(tail,'a',64);tail[63]='b';
 assert(search(tail,64,"aab",3)==tail+61&&search(tail,63,"aab",3)==NULL);
 assert(munmap(guard,page*2)==0);
 char directory[1024];snprintf(directory,sizeof directory,"%s/android-tmpnam-XXXXXX",getenv("TMPDIR")?getenv("TMPDIR"):"/private/tmp");assert(mkdtemp(directory));
 const char *prior=getenv("TMPDIR");char *saved_tmp=prior?strdup(prior):NULL;assert(setenv("TMPDIR",directory,1)==0);
 char generated[1025];memset(generated,0x7f,sizeof generated);assert(klj_tmpnam(generated)==generated);
 assert(!strncmp(generated,directory,strlen(directory))&&access(generated,F_OK)==-1&&errno==ENOENT&&generated[1024]==0x7f);
 assert(rmdir(directory)==0);if(saved_tmp){assert(setenv("TMPDIR",saved_tmp,1)==0);free(saved_tmp);}else unsetenv("TMPDIR");
 ldiv_t quotient=((ldiv_t(*)(long,long))klj_native_libc_lookup("ldiv"))(-17,5);assert(quotient.quot==-3&&quotient.rem==-2);
 assert(((long long(*)(long long))klj_native_libc_lookup("llabs"))(-INT64_C(0x100000001))==INT64_C(0x100000001));
 assert(((intmax_t(*)(intmax_t))klj_native_libc_lookup("imaxabs"))(-INTMAX_C(0x100000001))==INTMAX_C(0x100000001));
 lldiv_t wide=((lldiv_t(*)(long long,long long))klj_native_libc_lookup("lldiv"))(-INT64_C(0x100000001),7);
 assert(wide.quot*7+wide.rem==-INT64_C(0x100000001)&&wide.rem<0);
 imaxdiv_t widest=((imaxdiv_t(*)(intmax_t,intmax_t))klj_native_libc_lookup("imaxdiv"))(-INTMAX_C(0x100000001),7);
 assert(widest.quot==wide.quot&&widest.rem==wide.rem);
 assert(!strcmp(((const char*(*)(int))klj_native_libc_lookup("zError"))(Z_DATA_ERROR),"data error"));
 assert(wcscasecmp(L"ABC",L"abc")==0 && wcsncasecmp(L"ABX",L"aby",2)==0 && wcscasecmp(L"a",L"b")<0);
 iconv_t cv=klj_iconv_open("wchar_t","UTF_8");assert(cv!=(iconv_t)-1);
 char utf8[]="A\xc3\xa9",*input=utf8;size_t left=3;uint32_t decoded[3]={0xaaaaaaaa,0xbbbbbbbb,0xcccccccc};char *output=(char*)decoded;size_t space=4;
 assert(klj_iconv(cv,&input,&left,&output,&space)==(size_t)-1 && errno==E2BIG && left==2 && decoded[0]==65 && decoded[1]==0xbbbbbbbb);
 space=4;assert(klj_iconv(cv,&input,&left,&output,&space)==0 && left==0 && decoded[1]==233 && decoded[2]==0xcccccccc);
 char invalid[]="\xff";input=invalid;left=1;output=(char*)decoded;space=sizeof(decoded);
 assert(klj_iconv(cv,&input,&left,&output,&space)==(size_t)-1 && errno==EILSEQ && left==1);
 assert(klj_iconv(cv,NULL,NULL,NULL,NULL)==0);assert(klj_iconv_close(cv)==0);
 assert(klj_iconv_open("not-an-encoding","UTF-8")== (iconv_t)-1 && errno==EINVAL);
 assert(klj_iconv_close((iconv_t)-1)==-1 && errno==EBADF);
 char bytes[8]="abcdefg";assert(klj_memchr_chk(bytes,'d',8,8)==bytes+3);REFUSES(klj_memchr_chk(bytes,'d',9,8));
 FILE *file=tmpfile();assert(file);assert(fwrite("hello",1,5,file)==5);rewind(file);
 REFUSES(klj_fread_chk(bytes,3,3,file,8));assert(ftell(file)==0 && bytes[0]=='a');
 int64_t position=-1;assert(klj_fgetpos(file,&position)==0&&position==0);
 assert(kl_fseeko(file,3,SEEK_SET)==0&&klj_fsetpos(file,&position)==0&&ftello(file)==0);
 assert(klj_fgetpos(file,NULL)==-1&&errno==EINVAL);
 assert(klj_fread_chk(bytes,1,5,file,8)==5 && !memcmp(bytes,"hello",5));
 assert(klj_fread_chk(bytes,SIZE_MAX,2,file,8)==0 && errno==EOVERFLOW);fclose(file);
 int pair[2];assert(socketpair(AF_UNIX,SOCK_DGRAM,0,pair)==0);
 REFUSES(klj_sendto_chk(pair[0],bytes,9,8,0,NULL,0));assert(recv(pair[1],bytes,sizeof(bytes),MSG_DONTWAIT)<0 && errno==EAGAIN);
 assert(klj_sendto_chk(pair[0],"xyz",3,3,0,NULL,0)==3);assert(recv(pair[1],bytes,sizeof(bytes),0)==3 && !memcmp(bytes,"xyz",3));
 struct pollfd writable={.fd=pair[0],.events=0x100,.revents=0x7777};
 REFUSES(klj_poll_chk(&writable,2,0,sizeof(writable)));assert(writable.revents==0x7777);
 assert(klj_poll_chk(&writable,1,0,sizeof(writable))==1 && writable.revents==0x100);
 writable.events=0x2000;writable.revents=0x7777;assert(klj_poll_chk(&writable,1,0,sizeof(writable))==0 && writable.revents==0);
 struct iovec send_iov[2]={{"one",3},{"two",3}};
 klj_mmsghdr send[2]={0};for(int i=0;i<2;++i){send[i].msg_hdr.msg_iov=&send_iov[i];send[i].msg_hdr.msg_iovlen=1;send[i].msg_len=0xaaaa;send[i].padding=0xccccdddd;}
 assert(klj_sendmmsg(pair[0],send,2,0)==2 && send[0].msg_len==3 && send[1].msg_len==3 && send[1].padding==0xccccdddd);
 char data[3][8]={{0}};struct iovec ri[3];klj_mmsghdr receive[3]={0};
 for(int i=0;i<3;++i){ri[i]=(struct iovec){data[i],8};receive[i].msg_hdr.msg_iov=&ri[i];receive[i].msg_hdr.msg_iovlen=1;receive[i].msg_len=0xbbbb;receive[i].padding=0xeeeeffff;}
 struct timespec timeout={0,1};assert(klj_recvmmsg(pair[1],receive,3,0,&timeout)==-1 && errno==ENOSYS && receive[0].msg_len==0xbbbb);
 assert(klj_recvmmsg(pair[1],receive,3,0x10000,NULL)==2 && !memcmp(data[0],"one",3) && !memcmp(data[1],"two",3) && receive[2].msg_len==0xbbbb && receive[1].padding==0xeeeeffff);
 assert(klj_sendmmsg(pair[0],send,1,0x8000)==-1 && errno==ENOTSUP);
 assert(klj_sendmmsg(pair[0],send,1,0x40)==-1 && errno==ENOTSUP);
 assert(fcntl(pair[0],F_SETFL,O_NONBLOCK)==0);assert(klj_sendmmsg(pair[0],send,1,0x40)==1);
 assert(klj_recvmmsg(pair[1],receive,1,0x20,NULL)==-1 && errno==ENOTSUP);
 char control[32];receive[0].msg_hdr.msg_control=control;receive[0].msg_hdr.msg_controllen=sizeof(control);
 assert(klj_recvmmsg(pair[1],receive,1,0,NULL)==1 && receive[0].msg_hdr.msg_controllen==0);
 receive[0].msg_hdr.msg_control=NULL;
 send[1].msg_hdr.msg_iovlen=1025;send[1].msg_len=0xaaaa;
 assert(klj_sendmmsg(pair[0],send,2,0)==1 && send[1].msg_len==0xaaaa);
 assert(klj_recvmmsg(pair[1],receive,1,0,NULL)==1);close(pair[0]);close(pair[1]);
 assert(klj_sendmmsg(-1,send,1,0)==-1 && errno==EBADF);
 pid_t child=fork();assert(child>=0);if(!child)((void(*)(int))klj_native_libc_lookup("_Exit"))(17);
 int status;assert(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==17);
 puts("PASS libc conversion, checked I/O, LP64 batch messages and immediate exit");return 0;
}
