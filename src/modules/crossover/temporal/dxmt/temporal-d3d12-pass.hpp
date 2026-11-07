// Copyright (c) MacLauncher contributors. MIT license.
#pragma once
#include <memory>
#include <cmath>
#include "dxmt_scaler.hpp"
#include "temporal-d3d12.h"
namespace dxmt {
struct MLTemporal12Pass:EncoderData {
 Com<ID3D12Resource>resources[5];
 TextureViewRef images[5];
 Rc<TemporalScaler>scaler;
 WMTFXTemporalScalerProps props{};
};
struct MLTemporal12History {
 Com<ID3D12Device>device;
 Rc<TemporalScaler>scaler;
 WMTFXTemporalScalerInfo info{};
};
}
