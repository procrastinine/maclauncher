#include "resolution.h"
#include <assert.h>
#include <stdio.h>
int main(void){
 int n=0,d=0;assert(klj_resolution_ratio(NULL,NULL,&n,&d)&&n==1&&d==1);
 assert(!klj_resolution_ratio("off","2",&n,&d));
 const char *invalid[]={"0","-1","nan","2x","3","1.25"};
 for(unsigned i=0;i<sizeof(invalid)/sizeof(*invalid);i++)assert(!klj_resolution_ratio("metalfx",invalid[i],&n,&d));
 const char *factors[]={"1","1.5","2"};const int outputs[]={1,63,64,641,1080,1921,8192};
 for(unsigned f=0;f<3;f++){
  assert(klj_resolution_ratio("metalfx",factors[f],&n,&d));
  for(unsigned x=0;x<sizeof(outputs)/sizeof(*outputs);x++){
   int output=outputs[x],source=klj_resolution_dimension(output,n,d);
   assert(source>0&&source<=output&&source*n>=output*d&&(source-1)*n<output*d);
   uint64_t state=klj_resolution_pack(source,source,output,output);
   assert((state>>48)==source&&((state>>32)&65535)==source&&((state>>16)&65535)==output&&(state&65535)==output);
   assert(klj_resolution_coordinate(output/2.0f,source,output)==source/2.0f);
   assert(klj_resolution_coordinate(-output/2.0f,source,output)==-source/2.0f);
  }
 }
 assert(klj_resolution_dimension(0,2,1)==0&&klj_resolution_dimension(8193,2,1)==0);
 assert(klj_resolution_dimension(1920,2,1)==960&&klj_resolution_dimension(1080,2,1)==540);
 puts("Android source/output resolution and pointer coordinates passed");
}
