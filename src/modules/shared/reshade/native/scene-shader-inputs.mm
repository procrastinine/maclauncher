// Copyright (c) MacLauncher contributors. MIT license.
#include "scene-shader-inputs.hpp"
#include "scene-color-normalize.hpp"
#include <atomic>
#include <algorithm>
#include <cstring>
namespace macfx {namespace {
struct Declarations {std::vector<std::string>names;std::vector<RSShaderSceneBindingV1>bindings;std::vector<uint32_t>roles;bool projection=false;};
struct Storage {
 std::atomic<unsigned>references{1};std::shared_ptr<const Declarations>declarations;
 std::array<RSShaderSceneValueV1,RS_SHADER_SCENE_ROLE_COUNT>values{};
 std::array<id<MTLTexture>,RS_SHADER_SCENE_ROLE_COUNT>textures{};
 std::optional<RSSceneMatrices>matrices;std::shared_ptr<const SceneAovLease>aovs;
 std::shared_ptr<SceneAovNormalizer>normalizer;
 std::shared_ptr<SceneColorNormalizer>colors;
};
void retain(void*p){static_cast<Storage*>(p)->references.fetch_add(1,std::memory_order_relaxed);}
void release(void*p){auto*s=static_cast<Storage*>(p);if(s->references.fetch_sub(1,std::memory_order_acq_rel)==1)delete s;}
std::string reason(const std::vector<uint32_t>&roles,const RSTemporalFrame&s,const std::optional<RSSceneMatrices>&m,const std::shared_ptr<const SceneAovLease>&a){
 for(const auto role:roles){if(role>=RS_SHADER_SCENE_ROLE_COUNT)return "Unknown declared shader scene input";
 if(role<RS_SCENE_AOV_COUNT&&(!a||!a->value.images[role].texture))return "Needs matching renderer "+std::string(rsShaderSceneRoleNames[role]);
 if(role==RS_SHADER_SCENE_DEPTH&&!s.depth||role==RS_SHADER_SCENE_MOTION&&!s.motion||role==RS_SHADER_SCENE_EXPOSURE&&!s.exposure)return "Needs matching renderer "+std::string(rsShaderSceneRoleNames[role]);
 if(role==RS_SHADER_SCENE_VIEW_MATRIX&&(!m||!(m->flags&RS_SCENE_VIEW_VALID))||role==RS_SHADER_SCENE_PROJECTION_MATRIX&&(!m||!(m->flags&RS_SCENE_PROJECTION_VALID)))return "Needs matching renderer "+std::string(rsShaderSceneRoleNames[role]);
 if(role==RS_SHADER_SCENE_PROJECTION_MATRIX&&m){const auto clip=m->flags&(RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_CLIP_MINUS_ONE_TO_ONE);if(clip!=RS_SCENE_CLIP_ZERO_TO_ONE&&clip!=RS_SCENE_CLIP_MINUS_ONE_TO_ONE)return "The declared shader projection requires its actual depth clip range";}
 }return {};
}
}
struct SceneShaderInputs::Impl {id<MTLCommandQueue>queue;std::shared_ptr<Declarations>declarations=std::make_shared<Declarations>();uint32_t mask=0;std::shared_ptr<SceneAovNormalizer>normalizer;std::shared_ptr<SceneColorNormalizer>colors;explicit Impl(id<MTLCommandQueue>q):queue(q){}};
SceneShaderInputs::SceneShaderInputs(id<MTLCommandQueue>q,const std::map<std::string,uint32_t>&b,const std::optional<ImageColorDescription>&working):impl(std::make_shared<Impl>(q)){auto&declarations=*impl->declarations;declarations.names.reserve(b.size());declarations.bindings.reserve(b.size());for(const auto&[name,role]:b){declarations.names.push_back(name);declarations.bindings.push_back({declarations.names.back().c_str(),role,0});if(std::find(declarations.roles.begin(),declarations.roles.end(),role)==declarations.roles.end())declarations.roles.push_back(role);if(role<RS_SCENE_AOV_COUNT)impl->mask|=1u<<role;declarations.projection|=role==RS_SHADER_SCENE_PROJECTION_MATRIX;}if(impl->mask){impl->normalizer=std::make_shared<SceneAovNormalizer>(q);if(working)impl->colors=std::make_shared<SceneColorNormalizer>(q,*working);}}
ShaderResult SceneShaderInputs::prepare(const ShaderFrame&f,const RSTemporalFrame&s,const std::optional<RSSceneMatrices>&m,const std::shared_ptr<const SceneAovLease>&a){
 if(!f.commands||f.commands.commandQueue!=impl->queue)return {false,"Prepare named shader inputs for their actual command queue"};
 const auto problem=reason(impl->declarations->roles,s,m,a);if(!problem.empty())return {false,problem};
 if(impl->normalizer){auto ready=impl->normalizer->prepare(a->value,f.source.width,f.source.height,impl->mask,RS_SCENE_AOV_SPACE_WORLD,f.origin==FrameOrigin::BottomLeft);if(!ready.encoded)return ready;if(impl->colors)return impl->colors->prepare(impl->normalizer->layout(),impl->mask);}return {true,{}};
}
ShaderResult SceneShaderInputs::frame(const ShaderFrame&f,const RSTemporalFrame&s,const std::optional<RSSceneMatrices>&m,const std::shared_ptr<const SceneAovLease>&a,bool encode,SceneShaderInputFrame&out){
 if(!f.commands||f.commands.commandQueue!=impl->queue)return {false,"Named scene inputs require their prepared command queue"};
 const auto problem=reason(impl->declarations->roles,s,m,a);if(!problem.empty())return {false,problem};
 RSSceneAovs normalized{};if(impl->normalizer){if(encode){auto r=impl->normalizer->encode(f.commands,a->value,m,normalized);if(!r.encoded)return r;}else normalized=impl->normalizer->layout();}
 if(impl->colors){RSSceneAovs converted{};auto ready=impl->colors->frame(f.commands,normalized,s.preExposure,encode,converted);if(!ready.encoded)return ready;normalized=converted;}
 auto data=std::shared_ptr<Storage>(new Storage,release);data->aovs=a;data->normalizer=impl->normalizer;data->colors=impl->colors;data->matrices=m;data->declarations=impl->declarations;
 if(data->matrices&&impl->declarations->projection){
  auto&matrix=*data->matrices;const bool bottom=f.origin==FrameOrigin::BottomLeft,down=matrix.flags&RS_SCENE_PROJECTION_Y_DOWN;
  for(unsigned row=0;row<4;++row){auto*p=matrix.projection+row*4;if(matrix.flags&RS_SCENE_CLIP_MINUS_ONE_TO_ONE)p[2]=.5f*(p[2]+p[3]);if(down==bottom)p[1]=-p[1];if(!(matrix.flags&RS_SCENE_PROJECTION_JITTERED)){p[0]+=2*s.jitterX/s.renderWidth*p[3];p[1]+=2*s.jitterY/s.renderHeight*p[3];}}
  matrix.flags&=~uint32_t(RS_SCENE_CLIP_MINUS_ONE_TO_ONE);matrix.flags|=RS_SCENE_CLIP_ZERO_TO_ONE|RS_SCENE_PROJECTION_Y_DOWN|RS_SCENE_PROJECTION_JITTERED;
 }
 for(const auto role:impl->declarations->roles){auto&v=data->values[role];
 if(role<RS_SCENE_AOV_COUNT){const auto&i=normalized.images[role];v.texture=i.texture;v.width=i.width;v.height=i.height;v.origin=i.origin;v.encoding=i.encoding;v.space=i.space;}
 else if(role<=RS_SHADER_SCENE_EXPOSURE){v.texture=role==RS_SHADER_SCENE_DEPTH?s.depth:role==RS_SHADER_SCENE_MOTION?s.motion:s.exposure;auto t=(__bridge id<MTLTexture>)v.texture;v.width=t.width;v.height=t.height;v.origin=role==RS_SHADER_SCENE_EXPOSURE?0:uint32_t(f.origin==FrameOrigin::BottomLeft);v.encoding=RS_SCENE_AOV_SCALAR;}
 else v.matrix=role==RS_SHADER_SCENE_VIEW_MATRIX?data->matrices->view:data->matrices->projection;
 if(v.texture)data->textures[role]=(__bridge id<MTLTexture>)v.texture;
 }
 out.value={sizeof(RSShaderSceneInputsV1),RS_SHADER_SCENE_ABI_VERSION,(__bridge void*)f.commands,(__bridge void*)f.source,(__bridge void*)f.target,f.frameId,uint32_t(data->declarations->bindings.size()),data->matrices?data->matrices->flags:0,data->declarations->bindings.data(),data->values.data(),data.get(),retain,release};out.storage=data;
 if(encode)[f.commands addCompletedHandler:^(id<MTLCommandBuffer>){(void)data;}];return {true,{}};
}
}
