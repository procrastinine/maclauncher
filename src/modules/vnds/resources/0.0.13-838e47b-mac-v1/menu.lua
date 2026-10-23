local input_event = on("input", function(input)
  if input == "start" then
    return create_listbox({
      choices = {
        {
          text = "Save",
          action = function()
            return dispatch("save_slot")
          end
        },
        {
          text = "Load",
          action = function()
            return dispatch("load_slot", interpreter.base_dir)
          end
        },
        {
          text = "Settings",
          action = function()
            return dispatch("config_menu")
          end
        },
        {
          text = "Main Menu",
          action = function()
            return love.event.quit("restart")
          end
        },
        {
          text = "Quit",
          action = love.event.quit
        }
      },
      closable = true
    })
  end
end)