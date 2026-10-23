#pragma once
#import <QuartzCore/CALayer.h>
#include <OpenGL/OpenGL.h>
#include <memory>
#import <IOSurface/IOSurface.h>
namespace macfx {
class ViewPresentation;
class LayerPresentation;
std::shared_ptr<LayerPresentation> remotePresentation(CALayer *layer);
std::shared_ptr<ViewPresentation> openGLPresentation(CGLContextObj context);
std::shared_ptr<ViewPresentation> metalPresentation(CALayer *layer);
bool acceptsLayer(CALayer *layer);
bool acceptsOpenGL(CGLContextObj context);
bool openGLSize(CGLContextObj context,unsigned &width,unsigned &height);
void forgetOpenGL(CGLContextObj context);
void stopOpenGLPresentation(CGLContextObj context);
}
