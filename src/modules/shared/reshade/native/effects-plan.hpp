#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "output-policy.hpp"
#include "effect-quality.hpp"
#include <functional>
#include <variant>

namespace macfx {
struct EffectPlanRequirements {
    bool depth=false,motion=false,camera=false,viewMatrix=false,projectionMatrix=false;
    uint32_t sceneAovs=0;
    bool noisyColor=false,exposure=false;
    bool scene()const noexcept{return depth||motion||camera||viewMatrix||projectionMatrix||sceneAovs||noisyColor||exposure;}
};
using EffectPlanScalar=std::variant<std::monostate,bool,double,std::string>;
struct EffectPlanSettings {
    std::map<std::string,EffectPlanScalar> values;
    std::string string(const std::string &,std::string fallback={}) const;
    double number(const std::string &,double fallback=0) const;
    bool boolean(const std::string &,bool fallback=false) const;
};
struct EffectPlanNode {
    std::string id,kind,format,method,modelPath,modelOperation,resizeDirection,gpuWorkScope,inputPolicy;
    double intrinsicScale=1;
    std::vector<std::string> planeGroupMembers;
    bool enabled=true,preservesCoordinates=false,displaySubframes=false,realHistory=false;
    unsigned outputWidth=0,outputHeight=0;
    double presentationScale=0;
    double workingScale=1;
    // Adaptive processing size shared by Simple and Advanced plans.
    bool resolutionAuto=false;
    double outputScaleX=1,outputScaleY=1;
    bool outputPresentation=false;
    std::map<std::string,uint32_t>sceneBindings;
    ShaderSpec shader;
    EffectPlanSettings settings;
    EffectPlanRequirements requirements;
    // A row the reader could not accept stays in place, disabled, with this
    // reason. The other rows of the document still run.
    std::string rejection;
};
struct EffectPlanSize {unsigned width=0,height=0;};
// Spatial rows resize their previous row's actual image. Auto fits the final
// presentation. An explicit size takes precedence over presentation-relative
// sizing, which in turn precedes a scale of the preceding row's input.
EffectPlanSize spatialOutputSize(const EffectPlanNode &,EffectPlanSize input,EffectPlanSize presentation);
// outputRejection: an output block the reader could not accept. Output
// processing then stays at its defaults; the rows still run.
struct EffectPlanSnapshot {std::string revision,mode;std::vector<EffectPlanNode> nodes;OutputPolicy output;std::shared_ptr<const EffectQualityRequest>quality;bool unpairedSyntheticInput=false;std::string outputRejection;};
struct EffectPlanPoll {bool active=false,changed=false;std::string error;bool valid=false;};
// The launch configuration names a plan file (native-config.hpp).
bool effectPlanRequested() noexcept;
// One process reader parses each plan publication once, off the frame path,
// and publishes an immutable snapshot with the demand derived from it. A
// document that cannot be read, or that uses a newer schema, keeps the last
// accepted plan and reports its error. Within a readable document each row is
// validated on its own: an invalid row is bypassed with its reason.
//
// Demand of the current plan: enabled rows only, computed once per plan.
// Producers test their bit with one atomic load and do no work when it is clear.
enum PlanDemandFlag : uint32_t {
    PlanDemandProcessing=1,          // Advanced with enabled rows or output processing (mode 1)
    PlanDemandPassThrough=2,         // valid Advanced plan with nothing to process (mode 2)
    PlanDemandNativeFxOnly=4,        // every enabled row is same-size ReShadeFX without scene inputs
    PlanDemandDepth=8,               // a row reads image-frame depth alone (no camera or guides)
    PlanDemandTemporal=16,           // a temporal row, scene frame generation or scene inputs
    PlanDemandPresentationQueue=32,  // output motion clarity or frame generation
    PlanDemandIndependentImageQueue=64, // neural rows with no scene, temporal or generation row
    PlanDemandGeneration=128,        // a frame-generation row
    PlanDemandOutputPolicy=256,      // output processing (comparison, tone mapping, motion clarity)
};
struct PlanDemand {
    uint32_t flags=0;
    uint32_t sceneAovs=0;            // scene attachment mask (rsGetSceneAovDemand)
    uint32_t sceneFrame=0;           // RS_SCENE_* mask (rsGetSceneFrameDemand)
    bool has(PlanDemandFlag flag)const noexcept{return flags&flag;}
    int mode()const noexcept{return flags&PlanDemandProcessing?1:flags&PlanDemandPassThrough?2:0;}
};
// Demand of one document; the reader stores this for each accepted plan.
PlanDemand effectPlanDemand(const EffectPlanSnapshot &) noexcept;
// Current demand. Without a configured plan every field is zero and no reader exists.
PlanDemand effectPlanDemand() noexcept;
// One flag or mask of the current demand: a single atomic load.
bool effectPlanDemands(PlanDemandFlag) noexcept;
uint32_t effectPlanSceneAovDemand() noexcept;
uint32_t effectPlanSceneFrameDemand() noexcept;
// Reads the plan file now on the reader's queue and waits for the result. For
// commands that must observe a just-published plan; frames never call it.
void refreshEffectPlan() noexcept;
// The reader's accepted plan, or null. Copies one pointer under the reader's lock.
std::shared_ptr<const EffectPlanSnapshot> currentEffectPlan() noexcept;
// The process cannot open the plan path because policy refuses it, as in a
// Chromium helper after its sandbox engages. Such a process keeps the plan it
// read earlier and cannot follow later edits; reads are still retried.
bool effectPlanReadDenied() noexcept;
// 0: absent/Simple, 1: Advanced with enabled rows, 2: Advanced pass-through.
int effectPlanMode() noexcept;
// Metadata publication identity, including row/resource/parameter changes.
uint64_t effectPlanDemandGeneration() noexcept;
// The revision of the current valid Advanced pass-through plan (Off, master
// bypass or every row disabled), from the same metadata reader; false otherwise.
bool effectPlanBypassRevision(std::string &revision) noexcept;
// Counts adoptions of a new pass-through revision by that reader. Executors
// compare it with the value they last saw to retire an earlier processed image.
uint64_t effectPlanBypassEpoch() noexcept;
// Metadata-only: every enabled Advanced row is same-size native ReShadeFX
// without a scene-guide contract. No shader or model resources are prepared.
bool effectPlanNativeFxOnly() noexcept;
bool effectPlanNativeFxOnly(const EffectPlanSnapshot &) noexcept;
// One state belongs to one serialized frame owner. It is a view of the process
// reader: poll() adopts the reader's latest publication without file access,
// and an unchanged publication costs one atomic load. A frame retains its
// immutable snapshot while encoding; the host still owns targets, leases and
// submission. The view never encodes GPU commands, commits work or copies image data.
class EffectPlanState {
    struct Impl;
    std::unique_ptr<Impl> impl;
public:
    using Factory=std::function<std::shared_ptr<ShaderNode>(const EffectPlanNode &)>;
    EffectPlanState();
    ~EffectPlanState();
    EffectPlanState(const EffectPlanState &)=delete;
    EffectPlanState &operator=(const EffectPlanState &)=delete;
    EffectPlanPoll poll();
    EffectPlanPoll poll(bool force);
    std::shared_ptr<const EffectPlanSnapshot> snapshot() const;
    std::string error() const;
    std::shared_ptr<ShaderNode> shader(const EffectPlanNode &,const Factory &factory={});
};
}
