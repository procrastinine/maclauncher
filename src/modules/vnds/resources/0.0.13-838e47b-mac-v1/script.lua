require("util")
local pprint = require("lib/pprint")
local load, save, mem, mem_type, choose, files, find_script, escape_pattern, read_file, interpolate, ops, next_instruction, rest, getvalue, add, parse
load = function(base_dir, fs, data)
  if data == nil then
    data = {
      file = "main.scr"
    }
  end
  local s = {
    base_dir = base_dir,
    fs = fs,
    locals = { },
    globals = { }
  }
  s = _.extend(s, read_file(s, data.file))
  return _.extend(s, data)
end
save = function(s)
  return {
    file = s.file,
    locals = s.locals,
    globals = s.globals,
    n = s.n - 1
  }
end
mem = function(s, key)
  if s.locals[key] ~= nil then
    return s.locals
  else
    return s.globals
  end
end
mem_type = function(s, type)
  if type == "setvar" then
    return s.locals
  else
    return s.globals
  end
end
choose = function(s, val)
  s.locals["selected"] = val
end
files = nil
find_script = function(s, file)
  if files == nil then
    files = love.filesystem.getDirectoryItems(tostring(s.base_dir) .. "script/")
  end
  for _index_0 = 1, #files do
    local script_file = files[_index_0]
    if script_file:lower() == file:lower() then
      return script_file
    end
  end
end
escape_pattern = function(text)
  return text:gsub("([^%w])", "%%%1")
end
read_file = function(s, script_file)
  local file = find_script(s, script_file)
  local data = s.fs(tostring(s.base_dir) .. "script/" .. tostring(file))
  if data == nil then
    error("Cannot read " .. tostring(script_file) .. "! Please check the scripts folder/zip")
  end
  local ins = { }
  for line in string.gmatch(data, "[^\n]+") do
    if line ~= '' and line:sub(1, 1) ~= "#" then
      table.insert(ins, parse(line))
    end
  end
  local labels
  do
    local _tbl_0 = { }
    for i, ins in ipairs(ins) do
      if ins.type == "label" then
        _tbl_0[ins.label] = i
      end
    end
    labels = _tbl_0
  end
  return {
    file = file,
    ins = ins,
    labels = labels,
    n = 1
  }
end
interpolate = function(s, text)
  for var in text:gmatch("{$([^}]*)}") do
    text = text:gsub("{$" .. escape_pattern(var) .. "}", tostring(mem(s, var)[var]))
  end
  for var in text:gmatch("$(%S*)") do
    text = text:gsub("$" .. escape_pattern(var), tostring(mem(s, var)[var]))
  end
  return text
end
ops = {
  ["=="] = function(a, b)
    return a == b
  end,
  ["!="] = function(a, b)
    return a ~= b
  end,
  [">="] = function(a, b)
    return a >= b
  end,
  ["<="] = function(a, b)
    return a <= b
  end,
  ["<"] = function(a, b)
    return a < b
  end,
  [">"] = function(a, b)
    return a > b
  end,
  ["+"] = function(a, b)
    return add(b, a)
  end,
  ["-"] = function(a, b)
    return add(b, -a)
  end,
  ["="] = function(self)
    return self
  end,
  ["~"] = function(self)
    return nil
  end,
  ["if"] = 1,
  ["fi"] = -1
}
next_instruction = function(s)
  local original = s.ins[s.n]
  if original == nil then
    return s, nil
  end
  local ins = _.extend({ }, original)
  if original.value then
    ins.value = _.extend({ }, original.value)
  end
  s.n = s.n + 1
  if ins.path then
    ins.path = s.base_dir .. ins.path
  end
  local MEM
  if ins.var then
    MEM = mem(s, ins.var)
  end
  local _exp_0 = ins.type
  if "bgload" == _exp_0 or "setimg" == _exp_0 or "sound" == _exp_0 or "music" == _exp_0 or "delay" == _exp_0 or "cleartext" == _exp_0 or "text" == _exp_0 or "choice" == _exp_0 then
    if ins.type == "text" then
      ins.text = interpolate(s, ins.text)
    end
    if ins.type == "bgload" then
      ins.path = interpolate(s, ins.path)
    end
    if ins.type == "setimg" then
      ins.path = interpolate(s, ins.path)
    end
    if ins.type == "choice" then
      ins.choices = _.map(ins.choices, function(self)
        return interpolate(s, self)
      end)
    end
    return s, ins
  elseif "setvar" == _exp_0 or "gsetvar" == _exp_0 then
    MEM = mem_type(s, ins.type)
    ins.value.literal = ins.value.literal or MEM[ins.value.var] or 0
    MEM[ins.var] = ops[ins.modifier](ins.value.literal, MEM[ins.var])
    if ins.modifier == "~" then
      for key in pairs(MEM) do
        MEM[key] = nil
      end
    end
  elseif "random" == _exp_0 then
    MEM[ins.var] = math.random(ins.low, ins.high)
  elseif "if" == _exp_0 then
    local lhs = MEM[ins.var] or 0
    local rhs = ins.value.literal or MEM[ins.value.var] or 0
    if not ops[ins.modifier](lhs, rhs) then
      local count = 1
      while count > 0 do
        s.n = s.n + 1
        count = count + (ops[s.ins[s.n].type] or 0)
      end
    end
  elseif "goto" == _exp_0 then
    ins.label = interpolate(s, ins.label)
    s.n = s.labels[ins.label]
  elseif "jump" == _exp_0 then
    if ins.label ~= nil then
      ins.label = interpolate(s, ins.label)
    end
    ins.filename = interpolate(s, ins.filename):gsub('{', ''):gsub('}', '')
    s = _.extend(s, read_file(s, ins.filename))
    s.n = s.labels[ins.label] or s.n
  end
  return next_instruction(s)
end
rest = function(chunks, i)
  return _.join(_.rest(chunks, i), " ")
end
getvalue = function(chunks, index)
  local r = rest(chunks, index)
  if r:sub(1, 1) == '"' then
    return {
      literal = r:sub(2, -2)
    }
  else
    if num(r) ~= nil then
      return {
        literal = num(r)
      }
    else
      return {
        var = r
      }
    end
  end
end
add = function(a, b)
  if a == nil then
    return b
  else
    if _.any({
      a,
      b
    }, function(self)
      return type(self) == "string"
    end) then
      return a .. b
    else
      return a + b
    end
  end
end
parse = function(line)
  local c = { }
  for word in line:gmatch("%S+") do
    table.insert(c, word)
  end
  c[1] = ascii(c[1] or '')
  return _.extend({
    type = c[1]
  }, (function()
    local _exp_0 = c[1]
    if "bgload" == _exp_0 then
      return {
        path = "background/" .. c[2],
        frames = num(c[3])
      }
    elseif "setimg" == _exp_0 then
      return {
        path = "foreground/" .. c[2],
        x = num(c[3] or 0),
        y = num(c[4] or 0)
      }
    elseif "sound" == _exp_0 or "music" == _exp_0 then
      return {
        path = "sound/" .. c[2],
        n = num(c[3])
      }
    elseif "text" == _exp_0 then
      return {
        text = rest(c, 2)
      }
    elseif "choice" == _exp_0 then
      return {
        choices = split(rest(c, 2), "|")
      }
    elseif "gsetvar" == _exp_0 or "setvar" == _exp_0 or "if" == _exp_0 then
      return {
        var = c[2],
        modifier = c[3],
        value = getvalue(c, 4)
      }
    elseif "jump" == _exp_0 then
      return {
        filename = c[2],
        label = c[3]
      }
    elseif "delay" == _exp_0 then
      return {
        frames = num(c[2])
      }
    elseif "random" == _exp_0 then
      return {
        var = c[2],
        low = num(c[3]),
        high = num(c[4])
      }
    elseif "label" == _exp_0 or "goto" == _exp_0 then
      return {
        label = c[2]
      }
    elseif "cleartext" == _exp_0 then
      return {
        modifier = c[2]
      }
    else
      return { }
    end
  end)())
end
return {
  load = load,
  save = save,
  next_instruction = next_instruction,
  choose = choose
}