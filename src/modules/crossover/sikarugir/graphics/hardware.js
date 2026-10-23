const { execFile } = require("node:child_process");

const CACHE_MS = 5 * 60 * 1000;
let cached, pending;
function physicalAppleGpu(info) {
  const displays = Array.isArray(info?.SPDisplaysDataType) ? info.SPDisplaysDataType : [];
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  return [...displays, ...devices].some(device => {
    const name = String(device.sppci_model || device.spdisplays_chipset_model || device.deviceString || device.name || "");
    return /^Apple\s+M\d+\b/i.test(name) && !/virtual|paravirtual|software/i.test(name);
  });
}
function readDisplays() {
  return new Promise(resolve => {
    execFile("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"],
      { encoding: "utf8", timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, output) => {
        if (error) return resolve({ physicalAppleGPU: false, source: "unavailable" });
        try { resolve({ physicalAppleGPU: physicalAppleGpu(JSON.parse(output)), source: "system_profiler" }); }
        catch { resolve({ physicalAppleGPU: false, source: "unavailable" }); }
      });
  });
}
async function graphicsHardware(host = {}, { signal, read = readDisplays, now = Date.now } = {}) {
  signal?.throwIfAborted();
  if (typeof host.physicalAppleGPU === "boolean") return { physicalAppleGPU: host.physicalAppleGPU, source: "provided" };
  if (host.gpuInfo) return { physicalAppleGPU: physicalAppleGpu(host.gpuInfo), source: "gpu-info" };
  if (host.arch !== "arm64" || host.platform && host.platform !== "darwin") return { physicalAppleGPU: false, source: "host" };
  if (!cached || now() - cached.at >= CACHE_MS) {
    pending ||= Promise.resolve().then(read).catch(() => ({ physicalAppleGPU: false, source: "unavailable" }))
      .then(value => { cached = { value, at: now() }; return value; }).finally(() => { pending = null; });
    await pending;
  }
  signal?.throwIfAborted();
  return cached.value;
}
module.exports = { graphicsHardware, physicalAppleGpu,
  __test: { reset: () => { cached = null; pending = null; }, CACHE_MS } };
