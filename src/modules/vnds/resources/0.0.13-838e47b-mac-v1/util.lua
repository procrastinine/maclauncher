_ = require('lib/underscore')
wrap = function(self)
  return setmetatable({
    _val = self
  }, {
    __index = function(self, k)
      return function(_, ...)
        self._val = self._val[k](self._val, ...)
      end
    end
  })
end
unwrap = function(self)
  return self._val
end
num = tonumber
split = function(str, sep)
  if sep == nil then
    sep = "%s"
  end
  local _accum_0 = { }
  local _len_0 = 1
  for s in str:gmatch("([^" .. tostring(sep) .. "]+)") do
    _accum_0[_len_0] = s:match("^%s*(.-)%s*$")
    _len_0 = _len_0 + 1
  end
  return _accum_0
end
ascii = function(str)
  local s = { }
  for i = 1, str:len() do
    local byte = str:byte(i)
    if byte >= 32 and byte <= 126 then
      s[#s + 1] = string.char(byte)
    end
  end
  return table.concat(s)
end
get = function(t, ...)
  for _, k in ipairs({
    ...
  }) do
    t = t[k]
    if not t then
      return nil
    end
  end
  return t
end
center = function(size, bounds)
  return (bounds - size) / 2
end
deepcopy = function(orig)
  local orig_type = type(orig)
  local copy
  if orig_type == 'table' then
    copy = { }
    for orig_key, orig_value in next,orig,nil do
      copy[deepcopy(orig_key)] = deepcopy(orig_value)
    end
    setmetatable(copy, deepcopy(getmetatable(orig)))
  else
    copy = orig
  end
  return copy
end