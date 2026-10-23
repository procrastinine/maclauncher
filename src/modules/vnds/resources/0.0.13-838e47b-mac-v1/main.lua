-- Module-owned adapter. Original novel scripts and assets are never changed.
local ffi = require("ffi")
ffi.cdef[[
int PHYSFS_setWriteDir(const char *newDir);
int PHYSFS_mount(const char *newDir, const char *mountPoint, int appendToPath);
]]
local library = assert(os.getenv("MACLAUNCHER_VNDS_PHYSFS"), "Missing qualified LÖVE library")
local physfs = ffi.load(library)
local save_root = assert(os.getenv("MACLAUNCHER_VNDS_SAVES"), "Missing managed save root")
local game_root = assert(os.getenv("MACLAUNCHER_VNDS_ROOT"), "Missing original VNDS folder")
assert(physfs.PHYSFS_setWriteDir(save_root) == 1, "Cannot use managed VNDS saves")
assert(physfs.PHYSFS_mount(save_root, "", 0) == 1, "Cannot read managed VNDS saves")
assert(physfs.PHYSFS_mount(game_root, "novels/game", 1) == 1, "Cannot read original VNDS assets")
love.filesystem.setIdentity = function() return true end
love.filesystem.getSaveDirectory = function() return save_root end
-- Upstream keeps slots beside virtual novels. Redirect only those save names
-- to the flat managed write directory; all script/asset paths remain original.
local function save_name(name)
  if type(name) == "string" then
    local slot = name:match("^novels/game/+((save%d+%.json))$")
    if slot then return slot end
    if name == "novels/game/global.json" then return "global.json" end
  end
  return name
end
for _, name in ipairs({"read", "write", "append", "newFile", "getInfo", "remove"}) do
  local original = love.filesystem[name]
  love.filesystem[name] = function(file, ...) return original(save_name(file), ...) end
end
local json = require("lib/json")
local mounts_path = assert(os.getenv("MACLAUNCHER_VNDS_MOUNTS"), "Missing VNDS mount plan")
local mounts_file = assert(io.open(mounts_path, "rb"))
local mounts = json.decode(mounts_file:read("*a")); mounts_file:close()
for _, mount in ipairs(mounts) do
  assert(physfs.PHYSFS_mount(mount.path, mount.point, mount.prepend and 0 or 1) == 1, "Cannot mount original VNDS archive")
end
require("upstream")
local original_load = script.load
local original_next = script.next_instruction
local global_name = "novels/game/global.json"
local previous_globals = nil
local function persist_globals(state)
  if not state then return end
  local encoded = json.encode(state.globals)
  if encoded ~= previous_globals then
    assert(love.filesystem.write(global_name, encoded))
    previous_globals = encoded
  end
end
script.load = function(base, read, data)
  local state = original_load(base, read, data)
  if love.filesystem.getInfo(global_name, "file") then
    local globals = json.decode(love.filesystem.read(global_name))
    for key, value in pairs(globals) do state.globals[key] = value end
  end
  previous_globals = json.encode(state.globals)
  return state
end
script.next_instruction = function(state)
  local next_state, instruction = original_next(state)
  persist_globals(next_state)
  return next_state, instruction
end
love.load = function()
  love.resize(love.graphics.getWidth(), love.graphics.getHeight())
  dispatch("load")
  interpreter = script.load("novels/game/", love.filesystem.read)
  dispatch("restore", {})
  dispatch("next_ins")
end
local upstream_key = love.keypressed
love.keypressed = function(key, scancode, repeat_key)
  if (key == "q" or key == "w") and love.keyboard.isDown("lgui", "rgui") then love.event.quit(); return end
  if key == "escape" then key = "m" end
  return upstream_key(key, scancode, repeat_key)
end
