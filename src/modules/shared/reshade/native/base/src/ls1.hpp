#pragma once
#include "spatial.hpp"
namespace macfx {
struct Ls1Config {std::string modelPath;bool performance=false;float sharpness=.5f;};
class Ls1Encoder {
public:
 Ls1Encoder(id<MTLDevice>,const Ls1Config&);
 ~Ls1Encoder();
 SpatialStatus encode(id<MTLCommandBuffer>,const SpatialFrame&);
 const std::string& modelHash()const;
 unsigned modelVariant()const;
private:struct Impl;std::shared_ptr<Impl>impl;
};
}
