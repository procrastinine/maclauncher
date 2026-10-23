#include "bitmap-surface.hpp"
#include <cstdio>
#include <cstdlib>
#include <cstring>
static unsigned checks=0;
static void check(bool value){++checks;if(!value){std::fprintf(stderr,"Bitmap surface check %u failed\n",checks);std::exit(1);}}
static CGImageRef image(const unsigned char*bytes,unsigned width,unsigned height,CGImageAlphaInfo alpha){
    auto data=CFDataCreate(nullptr,bytes,width*height*4);auto provider=CGDataProviderCreateWithCFData(data);
    auto color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    auto result=CGImageCreate(width,height,8,32,width*4,color,kCGBitmapByteOrder32Little|alpha,provider,nullptr,false,kCGRenderingIntentDefault);
    CGColorSpaceRelease(color);CGDataProviderRelease(provider);CFRelease(data);return result;
}
static void pixel(const std::shared_ptr<macfx::BitmapSurface>&surface,unsigned x,unsigned y,const unsigned char*expected){
    const auto bytes=static_cast<const unsigned char*>(IOSurfaceGetBaseAddress(surface->surface))+y*IOSurfaceGetBytesPerRow(surface->surface)+x*4;
    for(unsigned i=0;i<4;++i)check(std::abs(int(bytes[i])-int(expected[i]))<=1);
}
int main(){@autoreleasepool{
 const size_t before=macfx::bitmapSurfaceReservation().load();
 {
  macfx::BitmapSurfacePool pool;
  const unsigned char opaque[]={0,0,255,0,0,255,0,17,255,0,0,11,255,255,255,0};
  auto source=image(opaque,2,2,kCGImageAlphaNoneSkipFirst);check(source!=nullptr);
  const auto imageClass=object_getClass((__bridge id)source);
  check(macfx::bitmapImageObject((__bridge id)source,imageClass));
  check(!macfx::bitmapImageObject([NSObject new],imageClass));check(!macfx::bitmapImageObject(@"arbitrary layer content",imageClass));
  auto color=CGColorSpaceCreateWithName(kCGColorSpaceSRGB);check(!macfx::bitmapImageObject((__bridge id)color,imageClass));CGColorSpaceRelease(color);
  std::printf("CGImage class: %s\n",class_getName(object_getClass((__bridge id)source)));
  auto uploaded=pool.upload(source);check(bool(uploaded));check(uploaded->opaque);check(uploaded->width==2&&uploaded->height==2);
  const unsigned char red[]={0,0,255,255},green[]={0,255,0,255},blue[]={255,0,0,255},white[]={255,255,255,255};
  pixel(uploaded,0,0,red);pixel(uploaded,1,0,green);pixel(uploaded,0,1,blue);pixel(uploaded,1,1,white);
  auto first=uploaded->surface;uploaded.reset();uploaded=pool.upload(source);check(uploaded->surface==first);check(pool.retained()==1);
  IOSurfaceIncrementUseCount(first);uploaded.reset();auto external=pool.upload(source);check(bool(external));check(external->surface!=first);
  IOSurfaceDecrementUseCount(first);external.reset();uploaded=pool.upload(source);check(uploaded->surface==first);
  std::vector<std::shared_ptr<macfx::BitmapSurface>>leases{uploaded};uploaded.reset();
  for(unsigned i=1;i<4;++i){auto next=pool.upload(source);check(bool(next));leases.push_back(next);}check(pool.retained()==4);
  check(!pool.upload(source));auto released=leases.back()->surface;leases.pop_back();auto reused=pool.upload(source);check(reused->surface==released);
  pool.clear();check(pool.retained()==0);check(macfx::bitmapSurfaceReservation().load()>before);leases.clear();reused.reset();
  {macfx::BitmapSurfacePool limited;const auto reserved=macfx::bitmapSurfaceReservation().exchange(256u*1024u*1024u);
   check(!limited.upload(source));macfx::bitmapSurfaceReservation().store(reserved);}
  const unsigned char transparent[]={0,0,128,128,0,0,0,0,64,32,16,64,0,255,0,255};
  auto alpha=image(transparent,2,2,kCGImageAlphaPremultipliedFirst);auto blended=pool.upload(alpha);check(bool(blended));check(!blended->opaque);
  for(unsigned y=0;y<2;++y)for(unsigned x=0;x<2;++x)pixel(blended,x,y,transparent+(y*2+x)*4);
  blended.reset();const unsigned char narrow[]={255,0,0,255};auto resized=image(narrow,1,1,kCGImageAlphaPremultipliedFirst);
  auto small=pool.upload(resized);check(bool(small));check(small->width==1&&small->height==1);check(pool.retained()==1);pixel(small,0,0,narrow);
  check(!pool.upload(nullptr));std::vector<unsigned char>wide(16385*4,255);auto oversized=image(wide.data(),16385,1,kCGImageAlphaNoneSkipFirst);
  check(oversized!=nullptr);check(!pool.upload(oversized));CGImageRelease(oversized);
  CGImageRelease(source);CGImageRelease(alpha);CGImageRelease(resized);
 }
 check(macfx::bitmapSurfaceReservation().load()==before);
 std::printf("PASS %u bitmap upload BGRA, skip-alpha, premultiplied transparency, orientation, lease bounds, reuse and resize checks\n",checks);
}return 0;}
