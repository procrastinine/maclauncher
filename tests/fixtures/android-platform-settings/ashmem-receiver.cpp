#include <jni.h>
#include <cutils/ashmem.h>
#include <linux/ashmem.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <fcntl.h>
#include <vector>
#include "descriptor-capability.h"
extern "C" JNIEXPORT void JNICALL Java_AshmemReceiver_inspect(JNIEnv* env,jclass,int fd,jobject socket){
 auto fail=[&](const char* message){env->ThrowNew(env->FindClass("java/lang/AssertionError"),message);};
 int channel=env->GetIntField(socket,env->GetFieldID(env->GetObjectClass(socket),"descriptor","I"));
 auto receive=[&](void* bytes,size_t size){auto* p=(char*)bytes;while(size){ssize_t n=read(channel,p,size);if(n<=0)return false;p+=n;size-=n;}return true;};
 uint32_t tokenSize;if(!receive(&tokenSize,sizeof(tokenSize))||!tokenSize||tokenSize>65536){fail("Native descriptor attachment is malformed");return;}
 std::vector<uint8_t> token(tokenSize);if(!receive(token.data(),token.size())){fail("Native descriptor attachment was truncated");return;}
 if(klj_ashmem_capability_import(fd,token.data(),token.size())<0){fail("Native descriptor capability was rejected");return;}
 int neighbor=open("/data/local/tmp/neighbor",O_RDONLY);if(neighbor>=0){close(neighbor);fail("Received descriptor capability exposed a neighboring private file");return;}
 fprintf(stderr,"PASS exact descriptor capability preserves neighboring file isolation\n");
 errno=0;int size=ioctl(fd,ASHMEM_GET_SIZE,0),error=errno;
 fprintf(stderr,"ORIGINAL_BIONIC_ASHMEM_GET_SIZE result=%d errno=%d valid=%d\n",size,error,ashmem_valid(fd));
 if(size!=16384||ashmem_get_size_region(fd)!=size){fail("Original Bionic ashmem descriptor recognition failed");return;}
 errno=0;void* readable=mmap(nullptr,size,PROT_READ,MAP_SHARED,fd,0);int mapError=errno;
 fprintf(stderr,"ORIGINAL_BIONIC_ASHMEM_READ_MAP result=%s errno=%d\n",readable==MAP_FAILED?"failed":"ok",mapError);
 if(readable==MAP_FAILED){fail("Received ashmem descriptor refused a read-only mapping");return;}munmap(readable,size);
 void* writable=mmap(nullptr,size,PROT_READ|PROT_WRITE,MAP_SHARED,fd,0);
 if(writable!=MAP_FAILED){munmap(writable,size);fail("Received ashmem descriptor accepted a writable mapping");return;}
 if(ashmem_set_prot_region(fd,PROT_READ|PROT_WRITE)>=0){fail("Received ashmem protection mask was widened");return;}
 char value=0;if(pwrite(fd,&value,1,0)>=0){fail("Received descriptor accepted a positioned write");return;}
 fprintf(stderr,"PASS original Bionic ashmem ioctls and read-only mapping/write enforcement\n");
}
