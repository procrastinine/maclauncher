#include <jni.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <unistd.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <arpa/inet.h>
static int peer=-1,dataPeer=-1,receiptRead=-1;
static void fail(JNIEnv*e,const char*message){jclass type=(*e)->FindClass(e,"java/lang/AssertionError");if(type)(*e)->ThrowNew(e,type,message);}
JNIEXPORT jint JNICALL Java_maclauncher_android_ProcessAuthority_fixtureNative(JNIEnv*e,jclass type,jboolean broken){
    (void)type;signal(SIGPIPE,SIG_IGN);
    int authority[2],data[2],receipt[2];
    if(socketpair(AF_UNIX,SOCK_STREAM,0,authority)||socketpair(AF_UNIX,SOCK_STREAM,0,data)||pipe(receipt)){fail(e,"Fixture descriptors failed");return -1;}
    peer=authority[1];dataPeer=data[1];receiptRead=receipt[0];
    if(broken){close(receiptRead);receiptRead=-1;}
    const char body[]="{\"op\":\"connect\"}";
    unsigned char bytes[4+sizeof(body)-1];uint32_t size=htonl(sizeof(body)-1);memcpy(bytes,&size,4);memcpy(bytes+4,body,sizeof(body)-1);
    union{struct cmsghdr align;char bytes[CMSG_SPACE(sizeof(int)*2)];}control={0};
    struct iovec iov={bytes,sizeof(bytes)};struct msghdr message={.msg_iov=&iov,.msg_iovlen=1,.msg_control=control.bytes,.msg_controllen=sizeof(control.bytes)};
    struct cmsghdr*c=CMSG_FIRSTHDR(&message);c->cmsg_level=SOL_SOCKET;c->cmsg_type=SCM_RIGHTS;c->cmsg_len=CMSG_LEN(sizeof(int)*2);
    int passed[2]={data[0],receipt[1]};memcpy(CMSG_DATA(c),passed,sizeof(passed));
    if(sendmsg(peer,&message,0)!=(ssize_t)sizeof(bytes))fail(e,"Fixture connection send failed");
    close(data[0]);close(receipt[1]);
    const char next[]="{\"op\":\"next\"}";size=htonl(sizeof(next)-1);
    if(write(peer,&size,4)!=4||write(peer,next,sizeof(next)-1)!=(ssize_t)sizeof(next)-1)fail(e,"Fixture authority send failed");
    return authority[0];
}
JNIEXPORT void JNICALL Java_maclauncher_android_ProcessAuthority_checkDataNative(JNIEnv*e,jclass type,jint descriptor){
    (void)type;char out=42,in=0;
    if(write(descriptor,&out,1)!=1||read(dataPeer,&in,1)!=1||in!=out)fail(e,"Transferred data capability did not retain its own socket");
    close(descriptor);
}
JNIEXPORT void JNICALL Java_maclauncher_android_ProcessAuthority_checkReceiptNative(JNIEnv*e,jclass type,jboolean broken){
    (void)type;if(broken)return;char accepted=0;
    if(read(receiptRead,&accepted,1)!=1||accepted!=1)fail(e,"Live sender did not receive adoption acknowledgement");
}
JNIEXPORT void JNICALL Java_maclauncher_android_ProcessAuthority_closeFixtureNative(JNIEnv*e,jclass type,jint descriptor){
    (void)e;(void)type;close(descriptor);close(peer);close(dataPeer);if(receiptRead>=0)close(receiptRead);peer=dataPeer=receiptRead=-1;
}
