on("load", function()
  return love.filesystem.remove('log.txt')
end)
on("event", function(name, ...)
  if name == "load" then
    return 
  end
  local log = tostring(os.date('%H:%M:%S')) .. " " .. tostring(name) .. " " .. tostring(pprint.pformat({
    ...
  })) .. "\n"
  return love.filesystem.append('log.txt', log)
end)
local should_debug = on("draw_debug", function()
  love.graphics.print(love.graphics.getWidth(), 1, 1)
  love.graphics.print(love.graphics.getHeight(), 1, 20)
  love.graphics.print(sx, 1, 40)
  return love.graphics.print(sy, 1, 60)
end)
return should_debug:remove()