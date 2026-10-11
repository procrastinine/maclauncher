const { execFileSync } = require("node:child_process");

function applyGraphicsEnvironment(env, settings = {}, { hardwareModel } = {}) {
  delete env.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL;
  const driver = settings.graphicsDriver || "auto";
  if (!["auto", "OpenGL"].includes(driver)) throw new Error("Unsupported FNA graphics driver.");
  if (hardwareModel === undefined && driver === "auto" && process.platform === "darwin") {
    try { hardwareModel = execFileSync("/usr/sbin/sysctl", ["-n", "hw.model"], { encoding: "utf8", timeout: 2000 }).trim(); } catch {}
  }
  if (driver === "OpenGL") env.FNA3D_FORCE_DRIVER = "OpenGL";
  if (settings.softwareOpenGL === true || driver === "auto" && /^VirtualMac\d+,\d+$/.test(hardwareModel || "")) {
    env.MACLAUNCHER_ALLOW_SOFTWARE_OPENGL = "1"; env.FNA3D_FORCE_DRIVER = "OpenGL";
  }
  return env;
}
module.exports = { applyGraphicsEnvironment };
