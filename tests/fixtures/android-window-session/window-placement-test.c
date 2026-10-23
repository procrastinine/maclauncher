#include <assert.h>
#include <stdio.h>
#include "window-placement.h"
static void contained(KLWindowPlacement p,int x,int y,int width,int height,int top,int left,int bottom,int right){
 assert(p.width>0&&p.height>0);
 assert(p.x-left>=x&&p.y-top>=y);
 assert(p.x+p.width+right<=x+width&&p.y+p.height+bottom<=y+height);
}
int main(void){
 /* Portrait rotation on a desktop with a menu bar and a bottom Dock. */
 KLWindowPlacement portrait=kl_window_placement(600,960,0,25,1920,995,28,0,0,0);
 contained(portrait,0,25,1920,995,28,0,0,0);
 assert(portrait.width==600&&portrait.height==960&&portrait.x==660&&portrait.y==56);
 /* A shorter visible desktop scales both axes; it never crops controls. */
 KLWindowPlacement small=kl_window_placement(600,960,0,25,1440,795,28,0,0,0);
 contained(small,0,25,1440,795,28,0,0,0);
 assert(small.height==767&&small.width==479);
 /* Secondary displays may have negative coordinates and asymmetric borders. */
 KLWindowPlacement other=kl_window_placement(2400,1200,-1920,-200,1920,1000,28,2,2,2);
 contained(other,-1920,-200,1920,1000,28,2,2,2);
 assert(other.width==1916&&other.height==958&&other.x==-1918&&other.y==-166);
 KLWindowPlacement normal=kl_window_placement(960,600,0,25,1920,995,28,0,0,0);
 assert(normal.width==960&&normal.height==600);
 puts("PASS logical window placement, work-area decorations, aspect and display coordinates");
}
