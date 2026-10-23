// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once
#include "spatial.hpp"
namespace macfx {
class MakoSpatialEncoder {
public:
 explicit MakoSpatialEncoder(id<MTLDevice>,float sharpness);
 ~MakoSpatialEncoder();
 void encode(id<MTLCommandBuffer>,const SpatialFrame&);
private:struct Impl;std::unique_ptr<Impl>impl;
};
}
