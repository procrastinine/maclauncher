#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "frame-depth.hpp"
#include "live-controls.hpp"
#include <memory>
#include <map>
#include <vector>
#include <filesystem>
namespace macfx {
using ShaderParameters=std::map<std::string,std::vector<float>>;
struct ShaderSpec {EffectSelection selection;ShaderParameters parameters;};
struct ShaderFrame {
    id<MTLCommandBuffer> commands;
    id<MTLTexture> source,target;
    uint64_t frameId=0;
    double timeMs=0;
    float frameTimeMs=16.666667f;
    FrameOrigin origin=FrameOrigin::TopLeft;
    SpatialColor color=SpatialColor::Perceptual;
    const DepthFrame *depth=nullptr;
    // Final game frames are opaque unless their publisher declares transparency.
    // Explicit transparent layers retain false through preparation and encoding.
    bool opaqueDisplay=true;
    unsigned totalSubframes=1,currentSubframe=1;
};
struct ShaderResult {bool encoded=false;std::string reason;bool busy=false;};
// A node owns one original provider runtime. The plan owns node ordering and
// distinct intermediate targets; the host owns synchronization and submission.
// encode never commits a frame or performs CPU image transfer. Resources used
// by an encoding survive node replacement through command completion.
class ShaderNode {
public:
    virtual ~ShaderNode()=default;
    virtual void setParameters(const ShaderParameters &)=0;
    // Compile and allocate for this real queue/extent without encoding the
    // borrowed buffer or advancing frame history. A plan prepares every row
    // before replacing its previous working execution.
    virtual ShaderResult prepare(const ShaderFrame &)=0;
    virtual ShaderResult encode(const ShaderFrame &)=0;
};
std::shared_ptr<ShaderNode> makeShaderNode(const ShaderSpec &);
std::shared_ptr<ShaderNode> forkCoreShaderNode(const std::shared_ptr<ShaderNode>&,const ShaderSpec&);
// Owned adapter resource capacity; immutable views preserve accepted histories.
// Optional ShaderNode providers keep the original frame/spec/vtable ABI.
std::shared_ptr<ShaderNode> coreShaderWithConcurrency(const std::shared_ptr<ShaderNode>&,unsigned);
inline bool libplaceboFile(const std::string &file){return std::filesystem::path(file).extension()==".hook";}
std::shared_ptr<ShaderNode> makeLibplaceboShaderNode(const ShaderSpec &);
}
