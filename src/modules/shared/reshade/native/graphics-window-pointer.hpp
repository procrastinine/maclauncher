#pragma once
#include "window-output-policy.hpp"
#include <memory>
namespace macfx {
struct PointerMotion {
 bool held=false,have=false;double x=0,y=0;
 void moved(double px,double py,double dx,double dy){if(!have||px!=x||py!=y)held=false;else if(dx||dy)held=true;x=px;y=py;have=true;}
};
struct PointerPosition {bool visible=false;double x=0,y=0;};
class PointerConstraint {
 struct Impl;std::shared_ptr<Impl>impl;
public:
 PointerPosition update(WindowRect,int,bool);
 void stop();
 ~PointerConstraint();
};
}
