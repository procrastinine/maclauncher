local json = require("lib/json")
local media, preview_slot, slot_ui
media = 0
on("resize", function()
  media = font:getHeight() * 3
end)
on("save_slot", function()
  local base_dir = interpreter.base_dir
  local write_slot
  write_slot = function(self)
    local save_table = {
      interpreter = script.save(interpreter)
    }
    dispatch_often("save", save_table)
    do
      local _with_0 = love.filesystem.newFile(self.data.fn, "w")
      _with_0:write(json.encode(save_table))
      _with_0:flush()
      _with_0:close()
    end
    local choice = preview_slot(self.data.i, self.data.fn, save_table, lfs.getInfo(self.data.fn))
    self.text = choice.text
    self.action = write_slot
    self.media = choice.media
    return false
  end
  return slot_ui(base_dir, write_slot, write_slot)
end)
on("load_slot", function(base_dir, closable)
  if closable == nil then
    closable = true
  end
  return slot_ui(base_dir, function(self)
    interpreter = script.load(base_dir, lfs.read, self.data.save.interpreter)
    dispatch("restore", self.data.save)
    dispatch("next_ins")
    return true
  end, function(self)
    interpreter = script.load(base_dir, lfs.read)
    dispatch("restore", { })
    dispatch("next_ins")
    return true
  end, closable)
end)
preview_slot = function(i, fn, save, info)
  local preview
  preview = function() end
  if save.background and save.background.path then
    local img = lg.newImage(save.background.path)
    local s = math.min(media / img:getWidth(), media / img:getHeight())
    preview = function(x, y)
      return lg.draw(img, x, y, 0, s, s)
    end
  end
  return {
    text = "Save " .. tostring(i) .. "\n" .. tostring(os.date("%x %H:%M", info.modtime)),
    media = preview,
    data = {
      save = save,
      fn = fn,
      i = i
    }
  }
end
slot_ui = function(base_dir, existing_slot, new_slot, closable)
  if closable == nil then
    closable = true
  end
  local choices = { }
  for i = 1, 10 do
    local fn = base_dir .. "/save" .. tostring(i) .. ".json"
    local info = lfs.getInfo(fn)
    if info then
      local save = json.decode(lfs.read(fn))
      local choice = preview_slot(i, fn, save, info)
      choice.action = existing_slot
      table.insert(choices, choice)
    else
      table.insert(choices, {
        text = "Save " .. tostring(i) .. " --",
        action = new_slot,
        data = {
          fn = fn,
          i = i
        }
      })
    end
  end
  return create_listbox({
    choices = choices,
    closable = closable,
    media = media
  })
end