// Copyright (c) MacLauncher contributors. SPDX-License-Identifier: MIT
#include "windows-input-state.h"
#include "windows-input.h"
#include "interface/input.h"
#include "../profile/profile_internal.h"
#include "../profile/vm.h"

namespace Impacto::Vm::WindowsInput {
namespace {
InputBank Bank;
bool Configured = false;
}  // namespace
void Configure() {
  auto* lua = Profile::LuaState;
  if (!lua) throw std::runtime_error("Windows input profile is unavailable");
  const int top = lua_gettop(lua);
  try {
    lua_getglobal(lua, "root");
    lua_getfield(lua, -1, "WindowsUiInput");
    if (!lua_istable(lua, -1)) throw std::runtime_error("Windows input metadata is unavailable");
    lua_getfield(lua, -1, "Version");
    if (!lua_isinteger(lua, -1) || lua_tointeger(lua, -1) != 1)
      throw std::runtime_error("Windows input metadata version is unsupported");
    lua_pop(lua, 1); lua_getfield(lua, -1, "Bank0");
    if (!lua_istable(lua, -1) || lua_rawlen(lua, -1) == 0 || lua_rawlen(lua, -1) > 128)
      throw std::runtime_error("Windows input regions exceed their bounds");
    std::vector<Region> regions;
    const auto scalar = [&](const char* key) {
      lua_getfield(lua, -1, key);
      if (!lua_isinteger(lua, -1)) throw std::runtime_error("Windows input region field is invalid");
      const auto value = lua_tointeger(lua, -1); lua_pop(lua, 1);
      if (value < INT32_MIN || value > INT32_MAX) throw std::runtime_error("Windows input region field exceeds its bounds");
      return static_cast<int>(value);
    };
    const size_t count = lua_rawlen(lua, -1);
    for (size_t i = 1; i <= count; ++i) {
      lua_rawgeti(lua, -1, i);
      if (!lua_istable(lua, -1)) throw std::runtime_error("Windows input region is invalid");
      regions.push_back({scalar("Id"), scalar("ParentId"), scalar("Relative"), scalar("X"), scalar("Y"),
                         scalar("Width"), scalar("Height"), static_cast<uint32_t>(scalar("Events"))});
      lua_pop(lua, 1);
    }
    Bank.Configure(std::move(regions)); Configured = true;
    lua_settop(lua, top);
  } catch (...) { lua_settop(lua, top); throw; }
}
void Reset() { Bank.Reset(); }
void Apply(uint8_t mode) {
  if (!Configured) throw std::runtime_error("Windows input metadata is unavailable");
  Bank.Apply(mode);
}
void PollMouse() {
  if (!Configured || !Profile::Vm::WindowsOpcodeExtensions) return;
  PointerFrame frame{Input::CurMousePos.x, Input::CurMousePos.y, Input::MouseWheelDeltaY,
    {Input::MouseButtonWentDown[SDL_BUTTON_LEFT], Input::MouseButtonWentDown[SDL_BUTTON_RIGHT]},
    {Input::MouseButtonIsDown[SDL_BUTTON_LEFT], Input::MouseButtonIsDown[SDL_BUTTON_RIGHT]}};
  Interface::PADinputMouseWentDown = Bank.Poll(frame);
  Interface::PADinputMouseIsDown = 0;
}
}  // namespace Impacto::Vm::WindowsInput
