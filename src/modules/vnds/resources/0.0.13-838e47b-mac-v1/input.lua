local keyboard_map = {
  ["down"] = "down",
  ["j"] = "down",
  ["k"] = "up",
  ["h"] = "left",
  ["l"] = "right",
  ["up"] = "up",
  ["left"] = "left",
  ["right"] = "right",
  ["space"] = "a",
  ["return"] = "a",
  ["x"] = "x",
  ["y"] = "y",
  ["m"] = "start",
  ["b"] = "b"
}
on("keyboard_input", function(self)
  if keyboard_map[self] then
    return dispatch("input", keyboard_map[self])
  end
end)
local gamepad_map = {
  ["dpdown"] = "down",
  ["dpup"] = "up",
  ["dpleft"] = "left",
  ["dpright"] = "right",
  ["a"] = "a",
  ["b"] = "b",
  ["y"] = "y",
  ["x"] = "x",
  ["start"] = "start"
}
return on("gamepad_input", function(self)
  if gamepad_map[self] then
    return dispatch("input", gamepad_map[self])
  end
end)