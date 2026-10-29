// Fast local Laplacian adaptation of Halide's local_laplacian generator.
// Copyright (c) 2012-2020 MIT CSAIL, Google, Facebook, Adobe, NVIDIA CORPORATION,
// and other contributors. See local-laplacian-MIT.txt and source declaration.
// Metal integration Copyright (c) MacLauncher contributors. MIT license.
#include "local-laplacian.hpp"
#include "image-admission.hpp"
#include "metal-library-cache.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <map>
#include <mutex>
#include <stdexcept>
#include <vector>
namespace macfx { namespace {
constexpr unsigned Octaves=8;
const std::string Source=R"METAL(#include <metal_stdlib>
using namespace metal;
struct Options {
 int gx,gy,cgx,cgy,ox,oy,cox,coy;
 uint width,height,samples,flip,alphaMode,opaque;
 float contrast;
};
int halfFloor(int x){return int(floor(float(x)*0.5f));}
float3 straight(float4 c,constant Options&o){return o.alphaMode==1?(c.a>0?c.rgb/c.a:float3(0)):c.rgb;}
float4 sourceColor(texture2d<float,access::read> source,int2 p,constant Options&o){
 p=clamp(p,int2(0),int2(source.get_width()-1,source.get_height()-1));
 if(o.flip)p.y=int(source.get_height())-1-p.y;float4 c=source.read(uint2(p));if(o.opaque||o.alphaMode==2)c.a=1;return c;
}
float gray(texture2d<float,access::read> source,int2 p,constant Options&o){return dot(clamp(straight(sourceColor(source,p,o),o),0.0f,1.0f),float3(.299f,.587f,.114f));}
float remap(float value,uint sample,constant Options&o,device const float*lut){
 const uint span=(o.samples-1)*256;int idx=clamp(int(value*float(span)),0,int(span));
 float level=float(sample)/float(o.samples-1);return o.contrast*(value-level)+level+lut[idx-int(sample*256)+int(span)];
}
float upArray(texture2d_array<float,access::read> image,int2 p,int2 origin,uint layer){
 int2 a=int2(halfFloor(p.x+1),halfFloor(p.y+1)),b=int2(halfFloor(p.x-1),halfFloor(p.y-1));
 float2 weight=(float2(uint2(p)&1u)*2+1)*.25f;
 float va=mix(image.read(uint2(int2(a.x,a.y)-origin),layer).x,image.read(uint2(int2(b.x,a.y)-origin),layer).x,weight.x);
 float vb=mix(image.read(uint2(int2(a.x,b.y)-origin),layer).x,image.read(uint2(int2(b.x,b.y)-origin),layer).x,weight.x);return mix(va,vb,weight.y);
}
float upImage(texture2d<float,access::read> image,int2 p,int2 origin){
 int2 a=int2(halfFloor(p.x+1),halfFloor(p.y+1)),b=int2(halfFloor(p.x-1),halfFloor(p.y-1));
 float2 weight=(float2(uint2(p)&1u)*2+1)*.25f;
 float va=mix(image.read(uint2(int2(a.x,a.y)-origin)).x,image.read(uint2(int2(b.x,a.y)-origin)).x,weight.x);
 float vb=mix(image.read(uint2(int2(a.x,b.y)-origin)).x,image.read(uint2(int2(b.x,b.y)-origin)).x,weight.x);return mix(va,vb,weight.y);
}
kernel void llFirst(texture2d<float,access::read> source[[texture(0)]],texture2d_array<float,access::write> output[[texture(1)]],constant Options&o[[buffer(0)]],device const float*lut[[buffer(1)]],uint2 p[[thread_position_in_grid]]){
 if(p.x>=o.width||p.y>=o.height)return;int2 base=(int2(p)+int2(o.ox,o.oy))*2;float values[16];
 for(int x=0;x<4;x++)for(int y=0;y<4;y++)values[x*4+y]=gray(source,base+int2(x-1,y-1),o);
 for(uint k=0;k<=o.samples;k++){
  float columns[4];for(uint x=0;x<4;x++){float v[4];for(uint y=0;y<4;y++)v[y]=k==o.samples?values[x*4+y]:remap(values[x*4+y],k,o,lut);columns[x]=(v[0]+3*(v[1]+v[2])+v[3])*.125f;}
  output.write((columns[0]+3*(columns[1]+columns[2])+columns[3])*.125f,p,k);
 }
}
kernel void llDown(texture2d_array<float,access::read> source[[texture(0)]],texture2d_array<float,access::write> output[[texture(1)]],constant Options&o[[buffer(0)]],uint3 p[[thread_position_in_grid]]){
 if(p.x>=o.width||p.y>=o.height||p.z>o.samples)return;int2 base=(int2(p.xy)+int2(o.ox,o.oy))*2-int2(o.gx,o.gy);float columns[4];
 for(int x=0;x<4;x++){float v[4];for(int y=0;y<4;y++)v[y]=source.read(uint2(base+int2(x-1,y-1)),p.z).x;columns[x]=(v[0]+3*(v[1]+v[2])+v[3])*.125f;}
 output.write((columns[0]+3*(columns[1]+columns[2])+columns[3])*.125f,p.xy,p.z);
}
kernel void llTop(texture2d_array<float,access::read> source[[texture(0)]],texture2d<float,access::write> output[[texture(1)]],constant Options&o[[buffer(0)]],uint2 p[[thread_position_in_grid]]){
 if(p.x>=o.width||p.y>=o.height)return;uint2 at=uint2(int2(p)+int2(o.ox-o.gx,o.oy-o.gy));float level=source.read(at,o.samples).x*float(o.samples-1);int li=clamp(int(level),0,int(o.samples)-2);
 output.write(mix(source.read(at,li).x,source.read(at,li+1).x,level-float(li)),p);
}
kernel void llReconstruct(texture2d_array<float,access::read> current[[texture(0)]],texture2d_array<float,access::read> coarse[[texture(1)]],texture2d<float,access::read> low[[texture(2)]],texture2d<float,access::write> output[[texture(3)]],constant Options&o[[buffer(0)]],uint2 p[[thread_position_in_grid]]){
 if(p.x>=o.width||p.y>=o.height)return;int2 position=int2(p)+int2(o.ox,o.oy);uint2 at=uint2(position-int2(o.gx,o.gy));float level=current.read(at,o.samples).x*float(o.samples-1);int li=clamp(int(level),0,int(o.samples)-2);
 float a=current.read(at,li).x-upArray(coarse,position,int2(o.cgx,o.cgy),li),b=current.read(at,li+1).x-upArray(coarse,position,int2(o.cgx,o.cgy),li+1);
 output.write(upImage(low,position,int2(o.cox,o.coy))+mix(a,b,level-float(li)),p);
}
kernel void llFinish(texture2d<float,access::read> source[[texture(0)]],texture2d_array<float,access::read> coarse[[texture(1)]],texture2d<float,access::read> low[[texture(2)]],texture2d<float,access::write> output[[texture(3)]],constant Options&o[[buffer(0)]],device const float*lut[[buffer(1)]],uint2 p[[thread_position_in_grid]]){
 if(p.x>=o.width||p.y>=o.height)return;int2 position=int2(p);float4 original=sourceColor(source,position,o);float3 rgb=clamp(straight(original,o),0.0f,1.0f);float g=dot(rgb,float3(.299f,.587f,.114f));float level=g*float(o.samples-1);int li=clamp(int(level),0,int(o.samples)-2);
 float a=remap(g,li,o,lut)-upArray(coarse,position,int2(o.cgx,o.cgy),li),b=remap(g,li+1,o,lut)-upArray(coarse,position,int2(o.cgx,o.cgy),li+1);
 float reconstructed=upImage(low,position,int2(o.cox,o.coy))+mix(a,b,level-float(li));float3 result=clamp(rgb*((reconstructed+.01f)/(g+.01f)),0.0f,1.0f);if(o.alphaMode==1)result*=original.a;
 uint2 out=p;if(o.flip)out.y=o.height-1-p.y;output.write(float4(result,original.a),out);
}
)METAL";
struct Settings {float detail=1,contrast=1;unsigned samples=8;ColorAlpha alpha=ColorAlpha::Straight;};
Settings settings(const ShaderParameters&params){Settings s;for(const auto&[key,value]:params){if(value.size()!=1||!std::isfinite(value[0]))throw std::invalid_argument("Local Laplacian parameters require finite scalar values");const float v=value[0];if(key=="Detail"&&v>=-1&&v<=4)s.detail=v;else if(key=="Contrast"&&v>=0&&v<=4)s.contrast=v;else if(key=="Samples"&&v>=2&&v<=16&&v==std::floor(v))s.samples=unsigned(v);else throw std::invalid_argument("Unsupported Local Laplacian parameter or value");}return s;}
struct Bounds {int x=0,y=0,lastX=0,lastY=0;unsigned width()const{return unsigned(lastX-x+1);}unsigned height()const{return unsigned(lastY-y+1);}};
int halfFloor(int x){return int(std::floor(double(x)/2));}
struct Options {int32_t gx=0,gy=0,cgx=0,cgy=0,ox=0,oy=0,cox=0,coy=0;uint32_t width=0,height=0,samples=8,flip=0,alphaMode=0,opaque=0;float contrast=1;};
struct Pipelines {id<MTLDevice>device;std::array<id<MTLComputePipelineState>,5>values;};
struct Resources {
 id<MTLDevice>device;id<MTLCommandQueue>queue;unsigned width=0,height=0,samples=0;float detail=0;
 std::shared_ptr<Pipelines>pipelines;std::array<Bounds,Octaves>gaussianBounds,outBounds;
 std::array<id<MTLTexture>,Octaves>gaussian,out;id<MTLBuffer>lut;std::shared_ptr<ImageReservation>lutReservation;std::atomic<bool>failed{false};
 bool matches(const ShaderFrame&f,const Settings&s)const{return device==f.commands.device&&queue==f.commands.commandQueue&&width==f.source.width&&height==f.source.height&&samples==s.samples&&detail==s.detail&&!failed.load();}
};
dispatch_queue_t retirement(){static auto queue=dispatch_queue_create("MacLauncher Local Laplacian retirement",DISPATCH_QUEUE_SERIAL);return queue;}
std::shared_ptr<Resources> resources(){return std::shared_ptr<Resources>(new Resources,[](Resources*p){dispatch_async(retirement(),^{delete p;});});}
id<MTLTexture> texture(id<MTLDevice>device,const Bounds&b,unsigned layers){auto d=[MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatR32Float width:b.width() height:b.height() mipmapped:NO];d.textureType=layers==1?MTLTextureType2D:MTLTextureType2DArray;d.arrayLength=layers;d.storageMode=MTLStorageModePrivate;d.usage=MTLTextureUsageShaderRead|MTLTextureUsageShaderWrite;return newAdmittedTexture(device,d,0,"Local Laplacian float pyramid");}
std::shared_ptr<Pipelines> pipelines(id<MTLDevice>device){static std::mutex lock;static std::map<void*,std::weak_ptr<Pipelines>>cache;{
 std::lock_guard guard(lock);if(auto previous=cache[(__bridge void*)device].lock())return previous;}
 NSError*error=nil;auto library=cachedMetalLibrary(device,Source,&error);if(!library)throw std::runtime_error(error.localizedDescription.UTF8String?:"Local Laplacian GPU compilation failed");auto p=std::make_shared<Pipelines>();p->device=device;NSArray<NSString*>*names=@[@"llFirst",@"llDown",@"llTop",@"llReconstruct",@"llFinish"];
 for(unsigned i=0;i<p->values.size();i++){p->values[i]=[device newComputePipelineStateWithFunction:[library newFunctionWithName:names[i]] error:&error];if(!p->values[i])throw std::runtime_error(error.localizedDescription.UTF8String?:"Local Laplacian GPU pipeline creation failed");}
 {std::lock_guard guard(lock);cache[(__bridge void*)device]=p;}return p;
}
void initialize(Resources&r,const ShaderFrame&f,const Settings&s){r.device=f.commands.device;r.queue=f.commands.commandQueue;r.width=(unsigned)f.source.width;r.height=(unsigned)f.source.height;r.samples=s.samples;r.detail=s.detail;r.pipelines=pipelines(r.device);
 r.outBounds[0]={0,0,int(r.width)-1,int(r.height)-1};
 for(unsigned j=1;j<Octaves;j++){const auto&p=r.outBounds[j-1];r.outBounds[j]={halfFloor(p.x-1),halfFloor(p.y-1),halfFloor(p.lastX+1),halfFloor(p.lastY+1)};}
 r.gaussianBounds=r.outBounds;
 // Exact finite domains for the original infinite repeat-edge expressions.
 // Clamping each intermediate pyramid would change its multiscale boundary.
 for(int j=Octaves-2;j>=1;j--){auto&g=r.gaussianBounds[j];const auto&c=r.gaussianBounds[j+1];g.x=std::min(g.x,2*c.x-1);g.y=std::min(g.y,2*c.y-1);g.lastX=std::max(g.lastX,2*c.lastX+2);g.lastY=std::max(g.lastY,2*c.lastY+2);}
 for(unsigned j=1;j<Octaves;j++){r.gaussian[j]=texture(r.device,r.gaussianBounds[j],s.samples+1);r.out[j]=texture(r.device,r.outBounds[j],1);}
 const int span=int((s.samples-1)*256);std::vector<float>lut(size_t(span)*2+1);for(int i=-span;i<=span;i++){const float x=float(i)/256;lut[i+span]=s.detail*x*std::exp(-x*x/2);}
 r.lutReservation=reserveImageBytes(r.device,lut.size()*sizeof(float),0,"Local Laplacian remap table");r.lut=[r.device newBufferWithBytes:lut.data() length:lut.size()*sizeof(float) options:MTLResourceStorageModeShared];if(!r.lut)throw std::runtime_error("Cannot allocate the Local Laplacian remap table");r.lutReservation->commit(r.lut.allocatedSize);
}
std::string validate(const ShaderFrame&f){if(!f.commands||!f.source||!f.target||f.source==f.target||f.commands.status>=MTLCommandBufferStatusCommitted||!f.commands.retainedReferences)return "Local Laplacian requires separate images and retaining unsubmitted Metal commands";if(f.source.device!=f.commands.device||f.target.device!=f.commands.device||f.source.textureType!=MTLTextureType2D||f.target.textureType!=MTLTextureType2D||f.source.sampleCount!=1||f.target.sampleCount!=1||f.source.width!=f.target.width||f.source.height!=f.target.height)return "Local Laplacian requires same-extent resolved images on the current GPU";if(!(f.source.usage&MTLTextureUsageShaderRead)||!(f.target.usage&MTLTextureUsageShaderWrite)||f.source.framebufferOnly||f.target.framebufferOnly)return "Local Laplacian requires shader-readable source and shader-writable output images";return {};}
class LocalLaplacian final:public ShaderNode {
 std::shared_ptr<const Settings>options;std::shared_ptr<Resources>state;
public:
 explicit LocalLaplacian(const ShaderParameters&params):options(std::make_shared<Settings>(settings(params))){}
 void setParameters(const ShaderParameters&params)override{auto next=settings(params);next.alpha=std::atomic_load(&options)->alpha;std::atomic_store(&options,std::shared_ptr<const Settings>(std::make_shared<Settings>(next)));}
 void setColor(const ImageColorDescription&color){if(!color.valid())throw std::invalid_argument("Invalid Local Laplacian input color description");auto next=std::make_shared<Settings>(*std::atomic_load(&options));next->alpha=color.alpha;std::atomic_store(&options,std::shared_ptr<const Settings>(next));}
 std::shared_ptr<LocalLaplacian>fork(const ShaderParameters&params){auto next=std::make_shared<LocalLaplacian>(params);next->state=std::atomic_load(&state);auto value=std::make_shared<Settings>(*next->options);value->alpha=std::atomic_load(&options)->alpha;next->options=value;return next;}
 ShaderResult prepare(const ShaderFrame&f)override{try{@autoreleasepool{if(auto error=validate(f);!error.empty())return {false,error,false};auto s=std::atomic_load(&options);auto current=std::atomic_load(&state);if(current&&current->matches(f,*s))return {true,{},false};auto next=resources();initialize(*next,f,*s);std::atomic_store(&state,next);return {true,{},false};}}catch(const std::exception&e){return {false,e.what(),false};}}
 ShaderResult encode(const ShaderFrame&f)override{try{@autoreleasepool{
  if(auto error=validate(f);!error.empty())return {false,error,false};auto s=std::atomic_load(&options);auto r=std::atomic_load(&state);if(!r||!r->matches(f,*s))return {false,"Local Laplacian resources are preparing for the current image",true};
  auto encoder=[f.commands computeCommandEncoder];if(!encoder)return {false,"Cannot create the Local Laplacian compute encoder",false};Options o;o.samples=s->samples;o.flip=f.origin==FrameOrigin::BottomLeft;o.alphaMode=unsigned(s->alpha);o.opaque=f.opaqueDisplay;o.contrast=s->contrast;
  auto dispatch=[&](unsigned pipeline,unsigned width,unsigned height,unsigned layers){o.width=width;o.height=height;[encoder setComputePipelineState:r->pipelines->values[pipeline]];[encoder setBytes:&o length:sizeof(o) atIndex:0];[encoder dispatchThreads:MTLSizeMake(width,height,layers) threadsPerThreadgroup:MTLSizeMake(8,8,1)];[encoder memoryBarrierWithScope:MTLBarrierScopeTextures];};
  const auto&first=r->gaussianBounds[1];o.ox=first.x;o.oy=first.y;[encoder setTexture:f.source atIndex:0];[encoder setTexture:r->gaussian[1] atIndex:1];[encoder setBuffer:r->lut offset:0 atIndex:1];dispatch(0,first.width(),first.height(),1);
  for(unsigned j=2;j<Octaves;j++){const auto&prev=r->gaussianBounds[j-1],&next=r->gaussianBounds[j];o.gx=prev.x;o.gy=prev.y;o.ox=next.x;o.oy=next.y;[encoder setTexture:r->gaussian[j-1] atIndex:0];[encoder setTexture:r->gaussian[j] atIndex:1];dispatch(1,next.width(),next.height(),s->samples+1);}
  const auto&g=r->gaussianBounds.back(),&top=r->outBounds.back();o.gx=g.x;o.gy=g.y;o.ox=top.x;o.oy=top.y;[encoder setTexture:r->gaussian.back() atIndex:0];[encoder setTexture:r->out.back() atIndex:1];dispatch(2,top.width(),top.height(),1);
  for(int j=Octaves-2;j>=1;j--){const auto&cur=r->gaussianBounds[j],&coarse=r->gaussianBounds[j+1],&out=r->outBounds[j],&low=r->outBounds[j+1];o.gx=cur.x;o.gy=cur.y;o.cgx=coarse.x;o.cgy=coarse.y;o.ox=out.x;o.oy=out.y;o.cox=low.x;o.coy=low.y;[encoder setTexture:r->gaussian[j] atIndex:0];[encoder setTexture:r->gaussian[j+1] atIndex:1];[encoder setTexture:r->out[j+1] atIndex:2];[encoder setTexture:r->out[j] atIndex:3];dispatch(3,out.width(),out.height(),1);}
  o.cgx=first.x;o.cgy=first.y;o.cox=r->outBounds[1].x;o.coy=r->outBounds[1].y;[encoder setTexture:f.source atIndex:0];[encoder setTexture:r->gaussian[1] atIndex:1];[encoder setTexture:r->out[1] atIndex:2];[encoder setTexture:f.target atIndex:3];dispatch(4,r->width,r->height,1);[encoder endEncoding];auto source=f.source,target=f.target;[f.commands addCompletedHandler:^(id<MTLCommandBuffer>done){if(done.status!=MTLCommandBufferStatusCompleted)r->failed=true;(void)source;(void)target;}];return {true,{},false};
 }}catch(const std::exception&e){return {false,e.what(),false};}}
};
}}
std::shared_ptr<macfx::ShaderNode>macfx::makeLocalLaplacianNode(const ShaderParameters&params){return std::make_shared<LocalLaplacian>(params);}
std::shared_ptr<macfx::ShaderNode>macfx::forkLocalLaplacianNode(const std::shared_ptr<ShaderNode>&previous,const ShaderParameters&params){auto node=std::dynamic_pointer_cast<LocalLaplacian>(previous);return node?node->fork(params):nullptr;}
void macfx::setLocalLaplacianNodeColor(const std::shared_ptr<ShaderNode>&value,const ImageColorDescription&color){auto node=std::dynamic_pointer_cast<LocalLaplacian>(value);if(node)node->setColor(color);}
