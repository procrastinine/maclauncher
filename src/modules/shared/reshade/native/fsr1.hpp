// SPDX-License-Identifier: BSD-3-Clause
#pragma once
#include "spatial.hpp"
#include <memory>
namespace macfx {
// Shared FSR1 reconstruction. Scratch images come from one pool per device,
// keyed by size and format, shared by all encoders (at most six pending) and
// charged to the process scratch budget. The encoder never submits, presents
// or waits.
class Fsr1Encoder {
public:
 Fsr1Encoder(id<MTLDevice> device);
 ~Fsr1Encoder();
 void encode(id<MTLCommandBuffer> commands,const SpatialFrame& frame,id<MTLTexture> scratch,float sharpness);
 bool encode(id<MTLCommandBuffer> commands,const SpatialFrame& frame,float sharpness,std::string& reason,bool* busy=nullptr);
private:
 struct Impl;std::unique_ptr<Impl> impl;
};
}
