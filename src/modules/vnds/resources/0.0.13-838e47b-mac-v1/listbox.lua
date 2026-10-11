local pad, remove_color, create_listbox
pad = 10
remove_color = function(self)
  local w = ""
  if type(self) == "string" then
    return self
  else
    for i = 2, #self, 2 do
      w = w .. self[i]
    end
  end
  return w
end
create_listbox = function(self)
  self.selected = self.selected or 1
  if self.choices[self.selected].onchange then
    self.choices[self.selected].onchange(self.choices[self.selected])
  end
  self.closable = self.closable or false
  self.allow_menu = self.allow_menu or false
  self.onclose = self.onclose or function() end
  self.media = self.media or -pad
  local font_height, close, input_event, draw_event
  dispatch("pause")
  font_height = function(text)
    local _, count = string.gsub(remove_color(text), "\n", "\n")
    return math.max(love.text_font:getHeight() * (1 + count), self.media)
  end
  close = function()
    input_event:remove()
    draw_event:remove()
    return dispatch("play")
  end
  input_event = on("input", function(input)
    local _exp_0 = input
    if "up" == _exp_0 then
      self.selected = (self.selected - 2) % #self.choices + 1
    elseif "down" == _exp_0 then
      self.selected = self.selected % #self.choices + 1
    end
    local chosen = self.choices[self.selected]
    if input == "up" or input == "down" then
      if chosen.onchange then
        chosen.onchange(chosen)
      end
    end
    if input == "a" then
      local outcome = chosen.action(chosen, close)
      if self.closable and outcome then
        close()
      end
      if not self.closable then
        close()
      end
    else
      if input == "start" and self.allow_menu then
        return true
      else
        if input == "b" and self.closable then
          close()
          self:onclose()
        else
          if input == "right" then
            if chosen.right then
              chosen.right(chosen)
            end
          else
            if input == "left" then
              if chosen.left then
                chosen.left(chosen)
              end
            end
          end
        end
      end
    end
    return false
  end)
  draw_event = on("draw_choice", function()
    lg.setFont(love.text_font)
    local w = 3 * pad + _.max((function()
      local _accum_0 = { }
      local _len_0 = 1
      local _list_0 = self.choices
      for _index_0 = 1, #_list_0 do
        local c = _list_0[_index_0]
        _accum_0[_len_0] = love.text_font:getWidth(remove_color(c.text))
        _len_0 = _len_0 + 1
      end
      return _accum_0
    end)()) + self.media
    local h, y_selected = pad, 0
    for i, c in ipairs(self.choices) do
      h = h + (font_height(c.text) + pad)
      if i == self.selected then
        y_selected = y_selected + h
      end
    end
    local x, y = center(w, lg.getWidth()), center(h, lg.getHeight())
    y = lg.getHeight() / 2 - y_selected
    lg.setColor(.18, .204, .251, .8)
    lg.rectangle("fill", x, y, w, h)
    local text_y = y + pad
    for i, c in ipairs(self.choices) do
      lg.setColor(1, 1, 1)
      if c.media then
        c.media(x + pad, text_y)
      end
      if i == self.selected then
        lg.setColor(.506, .631, .757)
      end
      lg.print(c.text, x + 2 * pad + self.media, text_y)
      text_y = text_y + (pad + font_height(c.text))
    end
    lg.setFont(font)
    return false
  end)
end
return {
  create_listbox = create_listbox
}