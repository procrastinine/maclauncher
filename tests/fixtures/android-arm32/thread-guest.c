#include <pthread.h>
#include <stdint.h>
static pthread_mutex_t mutex=PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition=PTHREAD_COND_INITIALIZER;
static unsigned arrived,count;
static pthread_key_t token_key;
static unsigned destroyed;
static int start;
static void retire_token(void *token){
    pthread_mutex_lock(&mutex);
    if((uintptr_t)token>=0xfeed0001u && (uintptr_t)token<=0xfeed0004u)++destroyed;
    pthread_mutex_unlock(&mutex);
}
static void *worker(void *argument){
    if(!pthread_equal(pthread_self(),pthread_self()))return 0;
    void *token=(void *)(uintptr_t)(0xfeed0000u+*(int *)argument);
    if(pthread_setspecific(token_key,token) || pthread_getspecific(token_key)!=token)return 0;
    pthread_mutex_lock(&mutex);++arrived;pthread_cond_broadcast(&condition);
    while(!start)pthread_cond_wait(&condition,&mutex);
    pthread_mutex_unlock(&mutex);
    for(unsigned n=0;n<1000;n++){pthread_mutex_lock(&mutex);++count;pthread_mutex_unlock(&mutex);}
    return argument;
}
int exercise_threads(void){
    pthread_t threads[4];int values[4]={1,2,3,4};
    if(pthread_key_create(&token_key,retire_token))return 5;
    for(unsigned n=0;n<4;n++)if(pthread_create(&threads[n],0,worker,&values[n]))return 1;
    pthread_mutex_lock(&mutex);while(arrived<4)pthread_cond_wait(&condition,&mutex);
    start=1;pthread_cond_broadcast(&condition);pthread_mutex_unlock(&mutex);
    for(unsigned n=0;n<4;n++){void *result=0;if(pthread_join(threads[n],&result)||result!=&values[n])return 2;}
    if(count!=4000)return 3;
    if(destroyed!=4 || pthread_key_delete(token_key))return 6;
    if(pthread_cond_destroy(&condition)||pthread_mutex_destroy(&mutex))return 4;
    return 0;
}
