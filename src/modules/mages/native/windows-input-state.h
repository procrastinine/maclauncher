// Copyright (c) MacLauncher contributors. SPDX-License-Identifier: MIT
#pragma once
#include <array>
#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <utility>
#include <vector>

namespace Impacto::Vm::WindowsInput {
struct Region {
  int Id{}, ParentId{}, Relative{}, X{}, Y{}, Width{}, Height{};
  uint32_t Events{};
};
struct PointerFrame {
  float X{}, Y{}, Wheel{};
  std::array<bool, 2> WentDown{}, IsDown{};
};
struct RegionEvent {
  int Id{};
  uint32_t Type{};
  float X{}, Y{}, Value{};
};

class InputBank {
 public:
  bool Enabled = false;
  int LeftSelector = 1, RightSelector = 2;
  bool MenuRequested = false;
  std::vector<RegionEvent> Events;

  void Configure(std::vector<Region> regions) {
    if (regions.empty() || regions.size() > 128)
      throw std::runtime_error("Windows input region count is invalid");
    InputBank staged;
    staged.Regions = std::move(regions);
    for (size_t i = 0; i < staged.Regions.size(); ++i) {
      const auto& r = staged.Regions[i];
      if (r.Id < 0 || r.Id > 65535 || r.ParentId < 0 || r.ParentId > 65535 ||
          (r.Relative != 0 && r.Relative != 1) || std::abs(int64_t(r.X)) > (1 << 20) ||
          std::abs(int64_t(r.Y)) > (1 << 20) || r.Width < 0 || r.Height < 0 ||
          r.Width > (1 << 20) || r.Height > (1 << 20) || r.Events > 0xfff)
        throw std::runtime_error("Windows input region is invalid");
      for (size_t j = i + 1; j < staged.Regions.size(); ++j)
        if (r.Id == staged.Regions[j].Id) throw std::runtime_error("Windows input region IDs are ambiguous");
      staged.Position(i, {});
    }
    Regions = std::move(staged.Regions);
  }
  void Reset() {
    Enabled = false;
    LeftSelector = 1; RightSelector = 2; MenuRequested = false;
    SavedLeft.fill(0); SavedRight.fill(0); Pressed.fill(false); Events.clear();
  }
  void Apply(uint8_t mode) {
    if (mode == 13) {
      if (Regions.empty()) throw std::runtime_error("Windows story input regions are unavailable");
      MenuRequested = false;
      SavedLeft[0] = LeftSelector; SavedRight[0] = RightSelector;
      LeftSelector = 1; RightSelector = 3; Enabled = true;
      Events.clear();
    } else if (mode == 14) {
      Enabled = false;
      LeftSelector = SavedLeft[0]; RightSelector = SavedRight[0];
      Events.clear();
    } else throw std::runtime_error("Unsupported Windows input bank operation");
  }
  uint32_t Poll(const PointerFrame& frame) {
    if (!std::isfinite(frame.X) || !std::isfinite(frame.Y) || !std::isfinite(frame.Wheel))
      throw std::runtime_error("Windows pointer coordinates are invalid");
    Events.clear();
    uint32_t result = 0;
    for (size_t i = 0; i < Regions.size(); ++i) {
      if (Enabled && Contains(i, frame.X, frame.Y)) {
        Emit(Regions[i], 1, frame);
        if (frame.Wheel > 0) Emit(Regions[i], 0x200, frame, frame.Wheel);
        if (frame.Wheel < 0) Emit(Regions[i], 0x400, frame, -frame.Wheel);
      }
    }
    if (frame.IsDown[0] && frame.IsDown[1]) {
      Pressed.fill(false);
      return 0;
    }
    for (size_t button = 0; button < 2; ++button) {
      if (frame.WentDown[button]) {
        Pressed[button] = true; StartX[button] = frame.X; StartY[button] = frame.Y;
        if (Enabled) for (size_t i = 0; i < Regions.size(); ++i)
          if (Contains(i, frame.X, frame.Y)) Emit(Regions[i], button ? 0x20 : 2, frame);
      }
      if (!Pressed[button] || frame.IsDown[button]) continue;
      Pressed[button] = false;
      if (Enabled) for (size_t i = 0; i < Regions.size(); ++i) {
        if (Contains(i, frame.X, frame.Y)) Emit(Regions[i], button ? 0x40 : 4, frame);
        if (Contains(i, StartX[button], StartY[button]) && Contains(i, frame.X, frame.Y))
          Emit(Regions[i], button ? 0x80 : 8, frame);
      }
      // The original selectors convert a complete click into a pad edge.
      // Keyboard/controller edges are separate and remain untouched.
      if (!button && LeftSelector == 1) result |= 0x1000;
      if (button && RightSelector == 2) result |= 0x2000;
      if (button && RightSelector == 3) { result |= 0x10; MenuRequested = true; }
    }
    return result;
  }
 private:
  std::vector<Region> Regions;
  std::array<int, 40> SavedLeft{}, SavedRight{};
  std::array<bool, 2> Pressed{};
  std::array<float, 2> StartX{}, StartY{};
  std::array<int64_t, 2> Position(size_t index, std::vector<size_t> ancestors) const {
    for (size_t parent : ancestors) if (parent == index)
      throw std::runtime_error("Windows input regions have a parent cycle");
    const auto& r = Regions[index];
    std::array<int64_t, 2> point{r.X, r.Y};
    if (r.Relative) {
      ancestors.push_back(index);
      size_t parent = 0;
      while (parent < Regions.size() && Regions[parent].Id != r.ParentId) ++parent;
      if (parent == Regions.size()) throw std::runtime_error("Windows input region parent is missing");
      if (Regions[parent].Relative)
        throw std::runtime_error("Nested Windows input region coordinates are unsupported");
      const auto base = Position(parent, std::move(ancestors));
      point[0] += base[0]; point[1] += base[1];
    }
    if (std::abs(point[0]) > (1 << 20) || std::abs(point[1]) > (1 << 20))
      throw std::runtime_error("Windows input region position exceeds its bounds");
    return point;
  }
  bool Contains(size_t index, float x, float y) const {
    const auto point = Position(index, {});
    const auto& r = Regions[index];
    return x >= point[0] && y >= point[1] && x < point[0] + r.Width && y < point[1] + r.Height;
  }
  void Emit(const Region& region, uint32_t type, const PointerFrame& frame, float value = 0) {
    if (region.Events & type) Events.push_back({region.Id, type, frame.X, frame.Y, value});
  }
};
}  // namespace Impacto::Vm::WindowsInput
