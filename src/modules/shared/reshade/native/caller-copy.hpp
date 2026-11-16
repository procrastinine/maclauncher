#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "effect-node.hpp"
#include "generation-schedule.hpp"
#include <memory>
#include <functional>
namespace macfx {
struct MetalFxImageInputs;struct SceneAovLease;class SdkInterpolationProcessor;
// Copy observation is suppressed only for this adapter's own GPU commands and
// for the exact original SDK producer operation whose output is registered.
class CallerCopyScope {bool previous;public:CallerCopyScope()noexcept;~CallerCopyScope();};
bool callerCopyObservation()noexcept;
class CallerIntervalCopies {
 struct Impl;std::shared_ptr<Impl>impl;
public:
 CallerIntervalCopies();~CallerIntervalCopies();
 ShaderResult stage(const std::shared_ptr<SdkInterpolationProcessor>&,const MetalFxImageInputs&,const std::shared_ptr<const SceneAovLease>&,const std::string&revision,const std::string&row);
};
bool callerCopyRecording(id<MTLCommandBuffer>)noexcept;
void observeCallerImageCopy(id<MTLCommandBuffer>,id<MTLTexture>,NSUInteger,NSUInteger,MTLOrigin,MTLSize,id<MTLTexture>,NSUInteger,NSUInteger,MTLOrigin);
void finishCallerImageCopies(id<MTLCommandBuffer>);
void performCallerCopyEnqueue(id<MTLCommandBuffer>,const std::function<void()>&original);
void performCallerCopyCommit(id<MTLCommandBuffer>,const std::function<void()>&original);
void observeCallerPresentation(id<MTLCommandBuffer>,id<MTLTexture>);
void observeCallerImageWrite(id<MTLCommandBuffer>,id<MTLTexture>);
void observeCallerUnknownWrite(id<MTLCommandBuffer>);
void observeCallerDrawable(id<MTLTexture>);
std::shared_ptr<CallerIntervalSourceOwnership>callerCopyIntervalSource(id<MTLTexture>);
void observeCallerSourcePresentation(id<MTLTexture>);
void copyCallerImageSourceTag(id<MTLTexture>,id<MTLTexture>);
}
