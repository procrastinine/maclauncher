#include "source-texture.hpp"
#include <cassert>
#include <cstdio>
int main(int argc,char **argv){@autoreleasepool{
 if(argc!=2)return 2;const std::filesystem::path root=argv[1];std::filesystem::create_directories(root);
 unsigned char pixels[16];for(unsigned i=0;i<16;i+=4){pixels[i]=24;pixels[i+1]=92;pixels[i+2]=170;pixels[i+3]=255;}
 macfx::ImageOwner<CGColorSpaceRef> color(CGColorSpaceCreateDeviceRGB());
 macfx::ImageOwner<CGContextRef> context(CGBitmapContextCreate(pixels,2,2,8,8,color.value,kCGImageAlphaPremultipliedLast|kCGBitmapByteOrder32Big));
 macfx::ImageOwner<CGImageRef> image(CGBitmapContextCreateImage(context.value));size_t budget=0;
 for(const auto &format:{std::pair<const char*,CFStringRef>{"sample.png",CFSTR("public.png")},{"sample.jpg",CFSTR("public.jpeg")}}){
  const auto file=(root/format.first).string();macfx::ImageOwner<CFURLRef> url(CFURLCreateFromFileSystemRepresentation(nullptr,(const UInt8*)file.data(),file.size(),false));
  macfx::ImageOwner<CGImageDestinationRef> destination(CGImageDestinationCreateWithURL(url.value,format.second,1,nullptr));assert(destination.value);CGImageDestinationAddImage(destination.value,image.value,nullptr);assert(CGImageDestinationFinalize(destination.value));
  reshadefx::texture texture;texture.width=8;texture.height=6;texture.levels=1;texture.format=reshadefx::texture_format::rgba8;
  reshadefx::annotation source;source.name="source";source.value.string_data=format.first;texture.annotations.push_back(source);
  const auto result=macfx::loadSourceTexture(texture,(root/"effect.fx").string(),budget);assert(result.width==8&&result.height==6&&result.pixels.size()==192);
  for(size_t i=0;i<result.pixels.size();++i)assert(std::abs(int(result.pixels[i])-int(pixels[i%4]))<=3);
  texture.width=16385;bool bounded=false;try{macfx::loadSourceTexture(texture,(root/"effect.fx").string(),budget);}catch(const std::runtime_error&){bounded=true;}assert(bounded);
  std::filesystem::remove(file);
 }
 assert(budget==384);puts("Source textures: PNG/JPEG decode, declared resize, color/alpha and dimension bounds passed");return 0;
}}
