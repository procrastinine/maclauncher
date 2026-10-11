local puremagic = require("lib/puremagic")
local sound, music, sound_volume, music_volume, filetype, load_source, clear, exists
sound = { }
music = { }
sound_volume, music_volume = nil, nil
filetype = {
  ["audio/x-aiff"] = "file.aiff",
  ["audio/x-flac"] = "file.flac",
  ["audio/mp4"] = "file.m4a",
  ["audio/x-matroska"] = "file.mka",
  ["audio/mpeg"] = "file.mp3",
  ["audio/vorbis"] = "file.ogg",
  ["audio/ogg"] = "file.ogg",
  ["audio/x-wav"] = "file.wav",
  ["audio/webm"] = "file.webm",
  ["audio/x-ms-wma"] = "file.wma"
}
load_source = function(self)
  local success, source = pcall(love.audio.newSource, self, "stream")
  if success then
    return source
  end
  local mime = puremagic.via_path(self)
  if filetype[mime] == nil then
    return nil
  end
  local original = lfs.newFileData(self)
  local actual = lfs.newFileData(original:getString(), filetype[mime])
  return love.audio.newSource(actual, "stream")
end
on("config", function(self)
  sound_volume = self.audio.sound / 100
  music_volume = self.audio.music / 100
  if next(sound) then
    sound.file:setVolume(sound_volume)
  end
  if next(music) then
    return music.file:setVolume(music_volume)
  end
end)
on("save", function(self)
  self.music = {
    path = music.path
  }
  self.sound = {
    path = sound.path,
    n = sound.n
  }
end)
on("restore", function(self)
  clear(music)
  clear(sound)
  if get(self, "music", "path") then
    dispatch("music", self.music)
  end
  if get(self, "sound", "path") then
    return dispatch("sound", self.sound)
  end
end)
clear = function(self)
  if next(self) then
    self.file:stop()
    self = { }
  end
end
exists = function(self)
  return self:sub(-1) ~= "~"
end
on("sound", function(self)
  clear(sound)
  if exists(self.path) and self.n ~= 0 then
    local file = load_source(self.path)
    if file == nil then
      return 
    end
    do
      file:setLooping(self.n == -1)
      file:setVolume(sound_volume)
      file:play()
      file = file
    end
    sound = {
      path = self.path,
      file = file,
      n = self.n or 0
    }
    return dispatch("sfx", sound)
  end
end)
on("music", function(self)
  clear(music)
  if exists(self.path) then
    local file = load_source(self.path)
    if file == nil then
      return 
    end
    do
      file:setLooping(true)
      file:setVolume(music_volume)
      file:play()
      file = file
    end
    music = {
      path = self.path,
      file = file
    }
  end
end)
return on("update", function()
  if next(sound) and not sound.file:isPlaying() and sound.n > 1 then
    sound.file:play()
    sound.n = sound.n - 1
  end
end)