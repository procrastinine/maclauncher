local LIP = require("lib/LIP")
local config, range, toggle
config = {
  audio = {
    music = 100,
    sound = 100
  },
  font = {
    override_font = false
  }
}
on("config_menu", function()
  local copy = deepcopy(config)
  return create_listbox({
    choices = {
      range(copy, "audio", "music", function(self)
        return "Music Volume " .. tostring(self.audio.music) .. "%"
      end),
      range(copy, "audio", "sound", function(self)
        return "Sound Volume " .. tostring(self.audio.sound) .. "%"
      end),
      toggle(copy, "font", "override_font", "Using System Font", "Using Novel Font"),
      {
        text = "Save Settings",
        action = function(choice, close)
          close()
          return dispatch("save_config", copy)
        end
      }
    },
    closable = true,
    onclose = function()
      return dispatch("config", config)
    end
  })
end)
on("load", function()
  local new_config = LIP.load("config.ini")
  for key, value in pairs(new_config) do
    _.extend(config[key], new_config[key])
  end
  return dispatch("config", config)
end)
on("save_config", function(new_config)
  config = new_config
  return LIP.save('config.ini', config)
end)
range = function(copy, section, key, text)
  return {
    text = text(copy),
    action = function() end,
    right = function(self)
      copy[section][key] = math.min(copy[section][key] + 10, 100)
      self.text = text(copy)
      return dispatch("config", copy)
    end,
    left = function(self)
      copy[section][key] = math.max(copy[section][key] - 10, 0)
      self.text = text(copy)
      return dispatch("config", copy)
    end
  }
end
toggle = function(copy, section, key, true_text, false_text)
  local text
  text = function()
    if copy[section][key] then
      return true_text
    else
      return false_text
    end
  end
  return {
    text = text(),
    action = function(self)
      copy[section][key] = not copy[section][key]
      self.text = text()
      return dispatch("config", copy)
    end
  }
end