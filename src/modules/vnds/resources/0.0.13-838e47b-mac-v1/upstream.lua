do
  local _obj_0 = require('event')
  dispatch, dispatch_often, on, remove, register = _obj_0.dispatch, _obj_0.dispatch_often, _obj_0.on, _obj_0.remove, _obj_0.register
end
create_listbox = require('listbox').create_listbox
love.graphics.setDefaultFilter("linear", "linear")
script = require("script")
pprint = require("lib/pprint")
Timer = require('lib/timer')
profile = require('lib/profile')
profile.setclock(love.timer.getTime)
lfs = love.filesystem
lg = love.graphics
interpreter = nil
require("audio")
require("debugging")
require("images")
require("text/text")
require("choose")
require("save")
require("input")
require("menu")
require("config")
os.setlocale("", "time")
lfs.setIdentity("VNDS-LOVE")
sx, sy = 0, 0
px, py = 0, 0
original_width, original_height = lg.getWidth(), lg.getHeight()
font = nil
love.text_font = nil
love.resize = function(w, h)
  sx, sy = w / original_width, h / original_height
  px, py = w / 256, h / 192
  local font_size = 32
  if w < 600 then
    font_size = 20
  end
  lg.setNewFont(font_size)
  font = lg.getFont()
  if love.text_font == nil then
    love.text_font = font
  end
  return dispatch("resize", {
    sx = sx,
    sy = sy,
    px = px,
    py = py
  })
end
next_msg = function(ins)
  if ins == nil then
    interpreter, ins = script.next_instruction(interpreter)
  end
  if ins == nil then
    return 
  end
  if ins.path then
    if ins.path:sub(-1) ~= "~" and not lfs.getInfo(ins.path) then
      return next_msg()
    end
  end
  local _exp_0 = ins.type
  if "text" == _exp_0 then
    if ins.text == "~" then
      return next_msg()
    else
      return dispatch("text", ins)
    end
  elseif "choice" == _exp_0 then
    return dispatch("choice", ins)
  elseif "delay" == _exp_0 then
    return Timer.after(ins.frames / 60, function()
      return next_msg()
    end)
  else
    dispatch(ins.type, ins)
    return next_msg()
  end
end
on("next_ins", next_msg)
love.load = function()
  love.resize(lg.getWidth(), lg.getHeight())
  dispatch("load")
  lfs.createDirectory("/novels")
  local novels = lfs.getDirectoryItems("/novels")
  local opts = { }
  local media = font:getHeight() * 3
  for i, novel in ipairs(novels) do
    local _continue_0 = false
    repeat
      local base_dir = "novels/" .. novel .. "/"
      if lfs.getInfo(base_dir, "file") then
        _continue_0 = true
        break
      end
      local icons = {
        "icon-high.png",
        "icon-high.jpg",
        "icon.png",
        "icon.jpg"
      }
      local thumbnails = {
        "thumbnail-high.png",
        "thumbnail-high.jpg",
        "thumbnail.png",
        "thumbnail.jpg"
      }
      local preview
      preview = function() end
      for _index_0 = 1, #icons do
        local icon = icons[_index_0]
        if lfs.getInfo(base_dir .. icon) then
          local img = lg.newImage(base_dir .. icon)
          local s = math.min(media / img:getWidth(), media / img:getHeight())
          preview = function(x, y)
            return lg.draw(img, x, y, 0, s, s)
          end
          break
        end
      end
      local path = "~"
      for _index_0 = 1, #thumbnails do
        local thumb = thumbnails[_index_0]
        if lfs.getInfo(base_dir .. thumb) then
          path = base_dir .. thumb
          break
        end
      end
      table.insert(opts, {
        text = novel,
        media = preview,
        onchange = function()
          return dispatch("bgload", {
            path = path
          })
        end,
        action = function()
          local files = lfs.getDirectoryItems(base_dir)
          do
            local _with_0 = wrap(_(files))
            _with_0:filter(function(self)
              return self:match("^.+(%..+)$") == ".zip"
            end)
            _with_0:map(function(self)
              return self:gsub(".zip", "")
            end)
            _with_0:reject(function(self)
              return _.include(files, self)
            end)
            _with_0:each(function(self)
              return lfs.mount(base_dir .. self .. ".zip", base_dir)
            end)
          end
          return dispatch("load_slot", base_dir, false)
        end
      })
      _continue_0 = true
    until true
    if not _continue_0 then
      break
    end
  end
  if next(opts) == nil then
    dispatch("text", {
      text = "No novels found in this directory: "
    })
    dispatch("text", {
      text = lfs.getSaveDirectory() .. "/novels"
    })
    return dispatch("text", {
      text = "Add one and restart the program"
    })
  else
    return create_listbox({
      choices = opts,
      media = media
    })
  end
end
love.draw = function()
  dispatch_often("draw_background")
  dispatch_often("draw_foreground")
  dispatch_often("draw_text")
  dispatch_often("draw_choice")
  dispatch_often("draw_ui")
  return dispatch_often("draw_debug")
end
if love._console_name == "3DS" then
  love.draw = function(self)
    if self ~= "bottom" then
      dispatch_often("draw_text")
      return dispatch_often("draw_choice")
    else
      dispatch_often("draw_background")
      dispatch_often("draw_foreground")
      dispatch_often("draw_ui")
      return dispatch_often("draw_debug")
    end
  end
end
paused = 0
on("pause", function()
  paused = paused + 1
end)
on("play", function()
  paused = paused - 1
end)
love.update = function(dt)
  dispatch_often("update", dt)
  if paused == 0 then
    return Timer.update(dt)
  end
end
is_fullscreen = false
love.keypressed = function(key)
  dispatch_often("keyboard_input", key)
  if key == "f11" then
    love.window.setFullscreen(is_fullscreen, "desktop")
    is_fullscreen = not is_fullscreen
  end
end
love.gamepadpressed = function(joy, button)
  return dispatch_often("gamepad_input", button)
end