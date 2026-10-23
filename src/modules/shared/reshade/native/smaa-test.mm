#import <Foundation/Foundation.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>
extern "C" bool rsProcessRGBA(void*,unsigned char*,unsigned,unsigned);
extern "C" void rsReleaseFrameOwner(void*);
int main(){@autoreleasepool{
 int context=0;unsigned changedTotal=0;
 for(auto size:{std::pair<unsigned,unsigned>{128,96},{193,127}}){
  const auto [w,h]=size;std::vector<unsigned char> input(w*h*4);
  for(unsigned y=0;y<h;++y)for(unsigned x=0;x<w;++x){auto p=&input[(y*w+x)*4];const bool light=y>int(x*.37+15);p[0]=light?230:48;p[1]=light?225:80;p[2]=light?210:112;p[3]=197;}
  for(unsigned frame=0;frame<3;++frame){auto pixels=input;if(!rsProcessRGBA(&context,pixels.data(),w,h))return 2;unsigned changed=0;
   for(unsigned y=0;y<h;++y)for(unsigned x=0;x<w;++x){const size_t offset=(y*w+x)*4;if(pixels[offset+3]!=197){puts("SMAA changed source alpha");return 3;}
    for(unsigned c=0;c<3;++c){const int delta=std::abs(int(pixels[offset+c])-int(input[offset+c]));if(delta>2){changed++;if(std::abs(double(y)-(x*.37+15))>4){puts("SMAA changed flat colors away from edges");return 4;}}}}
   if(changed<20||changed>w*h/4){printf("Unexpected SMAA edge coverage: %u\n",changed);return 5;}changedTotal+=changed;
   printf("SMAA %ux%u frame%u changed%u channels; flat colors and alpha retained\n",w,h,frame,changed);
  }
 }
 rsReleaseFrameOwner(&context);return changedTotal?0:6;
}}
