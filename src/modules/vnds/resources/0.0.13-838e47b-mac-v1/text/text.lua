local colorify
colorify = require("text/text_color").colorify
local buffer, backlog, lines, pad, override_font, update_font, done, fast_forward, word_wrap, concat
buffer = { }
backlog = { }
lines = 3
if love._console_name == "3DS" then
  lines = 7
end
pad = 10
override_font = nil
update_font = function()
  if interpreter and not override_font then
    local font_path = interpreter.base_dir .. "default.ttf"
    if lfs.getInfo(font_path) then
      love.text_font = lg.newFont(font_path, 32)
    end
  else
    love.text_font = font
  end
end
on("config", function(self)
  override_font = self.font.override_font
  return update_font()
end)
on("restore", function()
  update_font()
  buffer = { }
  backlog = { }
  if fast_forward then
    fast_forward:remove()
    fast_forward = nil
  end
end)
done = function()
  buffer = _.rest(buffer, lines + 1)
end
on("text", function(self)
  local no_input = false
  if self.text:sub(1, 1) == "@" then
    self.text = self.text:sub(2, -1)
    no_input = true
  end
  if self.text == '' or self.text == '!' then
    return 
  end
  local add = word_wrap(self.text, lg.getWidth() - 2 * pad)
  for _index_0 = 1, #add do
    local line = add[_index_0]
    table.insert(backlog, line)
  end
  if #buffer == lines and not no_input then
    buffer = add
  else
    buffer = concat(buffer, add)
    if no_input then
      return dispatch("next_ins")
    end
  end
end)
on("sfx", function(self)
  return table.insert(backlog, self)
end)
fast_forward = nil
on("input", function(self)
  if self == "a" then
    if #buffer > lines then
      done()
    else
      dispatch("next_ins")
    end
  else
    if self == "y" then
      if fast_forward then
        fast_forward:remove()
        fast_forward = nil
      else
        fast_forward = Timer.every(0.2, function()
          if #buffer > lines then
            return done()
          else
            return dispatch("next_ins")
          end
        end)
      end
    else
      if self == "x" then
        local last_ins = { }
        local images = { }
        local file, line = interpreter.file, interpreter.n
        local cancelled = deepcopy(interpreter)
        while true do
          local interpreter, ins = script.next_instruction(interpreter)
          interpreter = interpreter
          if interpreter.file == file and interpreter.n == line then
            interpreter = cancelled
            break
          end
          local _exp_0 = ins.type
          if "setimg" == _exp_0 then
            table.insert(images, ins)
          elseif "text" == _exp_0 or "sound" == _exp_0 or "music" == _exp_0 or "bgload" == _exp_0 then
            last_ins[ins.type] = ins
            if ins.type == "bgload" then
              images = { }
            end
          end
          if ins.type == "choice" then
            interpreter = interpreter
            buffer = { }
            for _index_0 = 1, #images do
              local img = images[_index_0]
              dispatch("next_ins", img)
            end
            for _index_0 = 1, #last_ins do
              local key, value = last_ins[_index_0]
              dispatch("next_ins", value)
            end
            dispatch("next_ins", ins)
            break
          end
        end
      else
        if self == "up" then
          local choices = { }
          for _index_0 = 1, #backlog do
            local line = backlog[_index_0]
            if line.file then
              table.insert(choices, {
                text = "[SFX]",
                action = function()
                  line.file:play()
                  return false
                end
              })
            else
              table.insert(choices, {
                text = line,
                action = function() end
              })
            end
          end
          create_listbox({
            choices = choices,
            closable = true,
            selected = #choices
          })
        end
      end
    end
  end
  return false
end)
on("draw_text", function()
  if #buffer > 0 then
    lg.setFont(love.text_font)
    local w, h = lg.getWidth() - 2 * pad, pad + (love.text_font:getHeight() + pad) * lines
    local x, y = pad, lg.getHeight() - h - pad
    lg.setColor(.18, .204, .251, .8)
    lg.rectangle("fill", x, y, w, h)
    lg.setColor(1, 1, 1)
    local y_pos = y + pad
    local draw_buffer = _.first(buffer, lines)
    for _index_0 = 1, #draw_buffer do
      local line = draw_buffer[_index_0]
      lg.print(line, 2 * pad, y_pos)
      y_pos = y_pos + (love.text_font:getHeight() + pad)
    end
    return lg.setFont(font)
  end
end)
word_wrap = function(text, max_width)
  local colored = colorify(text)
  local colors, words, last_color = { }, { }, { }
  local list = {
    { }
  }
  local l = 1
  local line = ""
  for i = 2, #colored, 2 do
    words = split(colored[i], " ")
    if #words > 0 then
      line = line .. words[1]
      last_color = colored[i - 1]
      for j = 2, #words do
        local tmp = line .. " " .. words[j]
        if love.text_font:getWidth(tmp) > max_width then
          table.insert(list[l], last_color)
          table.insert(list[l], line)
          l = l + 1
          table.insert(list, { })
          line = words[j]
        else
          line = tmp
        end
      end
      if #words > 1 then
        line = line .. " "
      end
    end
    table.insert(list[l], last_color)
    table.insert(list[l], line)
    line = ""
  end
  return list
end
concat = function(t1, t2)
  for i = 1, #t2 do
    t1[#t1 + 1] = t2[i]
  end
  return t1
end