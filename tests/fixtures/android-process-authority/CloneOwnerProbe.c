#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdint.h>
#include "bridge.h"
static void *completed(void *value){return value;}
int main(void){
 for(int i=0;i<2;i++){
  const int expected=i?EACCES:EMFILE;
  assert(klj_art_host(0xff00+(uint32_t)i,NULL,0)==0);
  pthread_t thread;
  int error=pthread_create(&thread,NULL,completed,NULL);
  if(error!=expected){fprintf(stderr,"clone owner errno expected=%d actual=%d\n",expected,error);return 1;}
  assert(klj_art_host(0xff02,NULL,0)==0);
  // The failed reservation must leave no registered child or leaked context.
  for(int n=0;n<8;n++){
   void *result=NULL;void *token=(void*)(uintptr_t)(n+1);
   assert(pthread_create(&thread,NULL,completed,token)==0);
   assert(pthread_join(thread,&result)==0&&result==token);
  }
 }
 puts("PASS original Bionic clone reservation errno and subsequent thread retirement");
 return 0;
}
