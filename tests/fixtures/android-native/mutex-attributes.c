#include <assert.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
extern int klb_pthread_mutexattr_init(int *),klb_pthread_mutexattr_destroy(int *);
extern int klb_pthread_mutexattr_settype(int *,int),klb_pthread_mutexattr_gettype(const int *,int *);
extern int klb_pthread_mutexattr_setpshared(int *,int),klb_pthread_mutexattr_getpshared(const int *,int *);
extern int klb_pthread_mutexattr_setprotocol(int *,int),klb_pthread_mutexattr_getprotocol(const int *,int *);
extern int klb_pthread_mutex_init(void *,const void *),klb_pthread_mutex_lock(void *),klb_pthread_mutex_unlock(void *),klb_pthread_mutex_destroy(void *);
int main(void){
 struct{uint32_t before;int value;uint32_t after;}attr={0x12345678,123,0x87654321};int out=-1;
 assert(!klb_pthread_mutexattr_init(&attr.value)&&attr.value==0);
 for(int type=0;type<=2;++type){assert(!klb_pthread_mutexattr_settype(&attr.value,type));assert(!klb_pthread_mutexattr_gettype(&attr.value,&out)&&out==type);for(int shared=0;shared<2;++shared){assert(!klb_pthread_mutexattr_setpshared(&attr.value,shared));assert(!klb_pthread_mutexattr_getpshared(&attr.value,&out)&&out==shared);for(int protocol=0;protocol<2;++protocol){assert(!klb_pthread_mutexattr_setprotocol(&attr.value,protocol));assert(!klb_pthread_mutexattr_getprotocol(&attr.value,&out)&&out==protocol);assert(!klb_pthread_mutexattr_gettype(&attr.value,&out)&&out==type);}}}
 int prior=attr.value;assert(klb_pthread_mutexattr_settype(&attr.value,3)==EINVAL&&attr.value==prior);assert(klb_pthread_mutexattr_setpshared(&attr.value,2)==EINVAL&&attr.value==prior);assert(klb_pthread_mutexattr_setprotocol(&attr.value,2)==EINVAL&&attr.value==prior);
 assert(!klb_pthread_mutexattr_init(&attr.value)&&!klb_pthread_mutexattr_settype(&attr.value,1)&&!klb_pthread_mutexattr_setpshared(&attr.value,0));
 _Alignas(16)uint8_t mutex[40]={0};assert(!klb_pthread_mutex_init(mutex,&attr.value));assert(!klb_pthread_mutex_lock(mutex)&&!klb_pthread_mutex_lock(mutex));assert(!klb_pthread_mutex_unlock(mutex)&&!klb_pthread_mutex_unlock(mutex)&&!klb_pthread_mutex_destroy(mutex));
 assert(!klb_pthread_mutexattr_destroy(&attr.value)&&attr.value==-1);assert(attr.before==0x12345678&&attr.after==0x87654321);
 puts("PASS complete original Bionic mutex attributes, independent bit fields and actual native recursive mutex");
}
