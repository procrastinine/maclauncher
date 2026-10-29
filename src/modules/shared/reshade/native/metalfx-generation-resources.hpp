#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "generation-provider.hpp"
#include <memory>
namespace macfx {
enum class MetalFxScalerProfile : uint32_t { Temporal=1,Denoised=2 };
// Native MetalFX's declared field representation, never a field derived from
// image RGB or reinterpreted as another provider's normalized coordinates.
enum class MetalFxDistortionUnits : uint32_t { NativeMetalFX=1 };
struct MetalFxDistortionField {
 id<MTLTexture>texture=nil;
 uint32_t x=0,y=0,width=0,height=0;
 MetalFxDistortionUnits units=MetalFxDistortionUnits::NativeMetalFX;
 id<MTLFence>fence=nil;
};
struct MetalFxScalerFrame;
class MetalFxScalerClaim {
 struct Impl;std::shared_ptr<Impl>impl;
 explicit MetalFxScalerClaim(std::shared_ptr<Impl>);friend struct MetalFxScalerFrame;
public:
 ~MetalFxScalerClaim();
 // A temporary strong reference only. A completion-owned claim does not own
 // the SDK object, which may itself retain its latest command buffer.
 id scaler()const;
 void retire()noexcept;
};
struct MetalFxScalerFrame {
 struct Control;std::shared_ptr<Control>control;
 RSTemporalFrame frame{};
 uint64_t resourceId=0;
 MetalFxScalerProfile profile=MetalFxScalerProfile::Temporal;
 ImageColorDescription color;
 id<MTLTexture>publishedColor=nil;
 uint32_t x=0,y=0,width=0,height=0;
 std::vector<id<MTLTexture>>retained;
 std::shared_ptr<const void>resources;
 std::shared_ptr<MetalFxScalerClaim>claim(const RSTemporalFrame&)const;
 // Immutable SDK descriptor profile only. This never authorizes encoding an
 // old image: the subsequent GPU use still needs claim(currentFrame).
 std::shared_ptr<MetalFxScalerClaim>claimForPreparation()const;
};
// ONLY owned encoder callers may use this mutation gate and return Busy.
// An unowned application's SDK calls must always retain original semantics;
// observing those calls never authorizes skipping a property write or encode.
class MetalFxScalerMutation {
 struct Impl;std::unique_ptr<Impl>impl;
public:
 explicit MetalFxScalerMutation(id ownedScaler);
 ~MetalFxScalerMutation();
 explicit operator bool()const noexcept;
 // Publish after the actual owned SDK encode. A distinct publishedColor is
 // admitted only by an owned RGB-identity/alpha-restoration boundary, with the
 // same explicit RGB domain and full output extent.
 bool publish(const RSTemporalFrame&actualSdkFrame,MetalFxScalerProfile,
     const ImageColorDescription&outputColor,id<MTLTexture>publishedColor=nil,
     std::shared_ptr<const void>resources={});
};
struct MetalFxGenerationResources {
 std::shared_ptr<const MetalFxScalerFrame>scaler;
 MetalFxDistortionField distortion;
 std::shared_ptr<const void>distortionResources;
};
std::shared_ptr<const MetalFxGenerationResources>metalFxGenerationResources(const RSTemporalFrame&);
// Exact immutable field metadata captured by an actual producer at its real
// image boundary. It is consumed only on that same unsubmitted classic CB;
// the provider copies it into prepared, per-flight GPU storage before use.
bool publishMetalFxGenerationDistortion(const RSTemporalFrame&,const MetalFxDistortionField&,
    std::shared_ptr<const void>resources={});
// An owned classic recording site calls this after original SDK encoding,
// supplying its actual real-image frame identity. No identity is inferred from
// an unpaired generated output or from a framework object's address.
bool captureMetalFxGenerationDistortion(const RSTemporalFrame&realFrame,id actualInterpolator,
    std::shared_ptr<const void>resources={});
// Install only on a classic SDK instance returned by the real public factory.
// Its encode always forwards original first. Metadata comes from an exact
// registered REAL input tuple and never from the SDK's midpoint destination.
void observeMetalFxClassicInterpolator(id);
// Derived scene association: an ordinary rebind preserves only exact color;
// copiedFrom additionally authorizes an explicit full-size/format byte blit.
bool bindMetalFxGenerationResources(const RSTemporalFrame&target,const RSTemporalFrame&source,
    id<MTLTexture>copiedFrom=nil);
}
