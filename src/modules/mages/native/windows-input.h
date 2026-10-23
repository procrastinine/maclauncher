// Copyright (c) MacLauncher contributors. SPDX-License-Identifier: MIT
#pragma once
#include <cstdint>
namespace Impacto::Vm::WindowsInput {
void Configure();
void Reset();
void Apply(uint8_t mode);
void PollMouse();
}
