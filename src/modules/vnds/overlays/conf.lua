function love.conf(t)
  t.identity = "maclauncher-vnds"
  t.version = "11.5"
  t.window.title = os.getenv("MACLAUNCHER_VNDS_TITLE") or "VNDS"
  t.window.width, t.window.height = 960, 640
  t.window.resizable = true
  t.window.fullscreen = os.getenv("MACLAUNCHER_VNDS_FULLSCREEN") == "1"
  t.modules.physics = false
end
