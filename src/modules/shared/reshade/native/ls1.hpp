#pragma once
#include "spatial.hpp"
namespace macfx {
struct Ls1Config {std::string modelPath;bool performance=false;float sharpness=.5f;};
class Ls1Encoder {
public:
 Ls1Encoder(id<MTLDevice>,const Ls1Config&);
 ~Ls1Encoder();
 // Worker-only image/parameter preparation; encode never allocates working images.
 SpatialStatus prepare(unsigned width,unsigned height);
 SpatialStatus encode(id<MTLCommandBuffer>,const SpatialFrame&);
 const std::string& modelHash()const;
 unsigned modelVariant()const;
private:struct Impl;std::shared_ptr<Impl>impl;
};
}
