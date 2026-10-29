#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "capture.hpp"
#include "native-source.h"
namespace maclauncher::fidelityfx {
// Only a native Vulkan owner, or its matching Wine Unix thunk after real
// handle unwrapping, constructs this binding. These are not PE callbacks.
using NativeUpscaleBinding=RSFfxVulkanBindingV1;
// Success means appended recording only. Original FFX CPU/GPU work and return
// value remain unchanged. Unknown optional contracts leave its output intact.
VkResult recordNativeUpscale(const UpscaleDispatch&,const NativeUpscaleBinding&);
}
