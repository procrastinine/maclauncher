local choose
choose = function(i)
  return function()
    script.choose(interpreter, i)
    return dispatch("next_ins")
  end
end
return on("choice", function(self)
  local choices
  do
    local _accum_0 = { }
    local _len_0 = 1
    for i, c in ipairs(self.choices) do
      _accum_0[_len_0] = {
        text = c,
        action = choose(i)
      }
      _len_0 = _len_0 + 1
    end
    choices = _accum_0
  end
  return create_listbox({
    choices = choices,
    allow_menu = true
  })
end)