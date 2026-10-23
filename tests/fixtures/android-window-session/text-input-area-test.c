#include <assert.h>
#include <stdio.h>
#include "text-input-area.h"
int main(void){
 SDL_Rect area;
 assert(klj_text_input_area(940,816,941,860,2560,1600,1280,800,&area));assert(area.x==470&&area.y==408&&area.w==1&&area.h==22);
 assert(klj_text_input_area(470,408,471,430,1280,800,1280,800,&area));assert(area.x==470&&area.y==408&&area.w==1&&area.h==22);
 assert(klj_text_input_area(50,25,51,45,1000,500,750,375,&area));assert(area.x==37&&area.y==18&&area.w==2&&area.h==16);
 assert(klj_text_input_area(-5,-3,2000,1000,1000,500,750,375,&area));assert(area.x==0&&area.y==0&&area.w==750&&area.h==375);
 assert(!klj_text_input_area(NAN,0,1,1,100,100,100,100,&area));assert(!klj_text_input_area(0,0,1,1,0,100,100,100,&area));
 puts("PASS Retina, render-resolution and resized-window text geometry");
}
