#pragma once
// Copyright (c) MacLauncher contributors. MIT license.
#include "observation.h"

namespace maclauncher::fidelityfx {
// Resolves only the loaded Wine PE interface. Success returns one owned storage
// reference; the caller releases it after installing through the V1 table.
// Native preparation remains lazy until an original successful observation.
bool createWineObserver(MLFfxObserverV1&)noexcept;
}
