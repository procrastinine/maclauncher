local Timer = require('lib/timer')
local background = { }
local images = { }
local alpha = {
  value = 1
}
on("save", function(self)
  self.background = {
    path = background.path
  }
  self.images = _.map(images, function(self)
    return {
      path = self.path,
      x = self.x,
      y = self.y
    }
  end)
end)
on("restore", function(self)
  background = { }
  images = { }
  alpha = {
    value = 1
  }
  if get(self, "background", "path") then
    dispatch("bgload", self.background)
  end
  if self.images then
    local _list_0 = self.images
    for _index_0 = 1, #_list_0 do
      local image = _list_0[_index_0]
      dispatch("setimg", image)
    end
  end
end)
on("bgload", function(self)
  background = { }
  if self.path:sub(-1) == "~" then
    return 
  end
  if self.frames ~= nil then
    alpha.value = 0
    Timer.tween(self.frames / 60, {
      [alpha] = {
        value = 1
      }
    })
  end
  background = {
    path = self.path,
    img = lg.newImage(self.path)
  }
  local w, h = background.img:getDimensions()
  if w ~= original_width or h ~= original_height then
    original_width, original_height = w, h
    love.resize(lg.getWidth(), lg.getHeight())
  end
  images = { }
end)
on("setimg", function(self)
  return table.insert(images, {
    path = self.path,
    img = lg.newImage(self.path),
    x = self.x,
    y = self.y
  })
end)
on("draw_background", function()
  lg.setColor(1, 1, 1, alpha.value)
  local scale = math.min(sx, sy)
  if next(background) then
    return lg.draw(background.img, lg.getWidth() / 2, lg.getHeight() / 2, 0, scale, scale, background.img:getWidth() / 2, background.img:getHeight() / 2)
  end
end)
return on("draw_foreground", function()
  local scale = math.min(sx, sy)
  local pscale = math.min(px, py)
  local offsetX = lg.getWidth() / 2 - original_width * scale / 2
  local offsetY = lg.getHeight() / 2 - original_height * scale / 2
  return _.each(images, function(self)
    return lg.draw(self.img, self.x * pscale + offsetX, self.y * pscale + offsetY, 0, scale, scale)
  end)
end)