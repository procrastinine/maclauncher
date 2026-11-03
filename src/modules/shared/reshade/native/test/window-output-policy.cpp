#include "window-output-policy.hpp"
#include <cassert>
int main(){
 using namespace macfx;const WindowRect visible{0,0,1200,800};
 for(auto t:{WindowRect{400,300,200,100},WindowRect{100,100,1000,600}})for(double f:{1.5,2.,10.}){
  auto a=windowFactorArea(t,visible,f);assert(a.width<=visible.width&&a.height<=visible.height);assert(windowRectContains(visible,a));
  assert(a.x==std::floor(a.x)&&a.y==std::floor(a.y)&&a.width==std::floor(a.width));assert(std::abs(a.width/a.height-t.width/t.height)<.01);
  auto p=windowImagePoint(a,t,t.x+10,t.y+20);auto q=windowMapPoint(a,t,p.x,p.y);assert(q&&std::abs(q->x-t.x-10)<1e-6&&std::abs(q->y-t.y-20)<1e-6);
 }
}
