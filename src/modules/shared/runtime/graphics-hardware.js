const { execFile } = require("node:child_process");

const CACHE_MS = 5 * 60 * 1000;
let cached, pending;
function gpuNames(info) {
  const displays = Array.isArray(info?.SPDisplaysDataType) ? info.SPDisplaysDataType : [];
  const devices = Array.isArray(info?.gpuDevice) ? info.gpuDevice : [];
  return [...new Set([...displays, ...devices].map(device =>
    String(device.sppci_model || device.spdisplays_chipset_model || device.deviceString || device.name || "").trim()).filter(Boolean))];
}
function physicalAppleGpu(info) {
  return gpuNames(info).some(name => /^Apple\s+M\d+\b/i.test(name) && !/virtual|paravirtual|software/i.test(name));
}
function gpuName(info) {
  const names = gpuNames(info);
  // Several adapters need an actual selection; their enumeration order is not one.
  return names.length === 1 ? names[0] : null;
}
function readDisplays() {
  return new Promise(resolve => {
    execFile("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"],
      { encoding: "utf8", timeout: 4000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, output) => {
        if (error) return resolve({ physicalAppleGPU: false, source: "unavailable" });
        try {
          const info = JSON.parse(output);
          resolve({ physicalAppleGPU: physicalAppleGpu(info), gpuName: gpuName(info), source: "system_profiler" });
        }
        catch { resolve({ physicalAppleGPU: false, source: "unavailable" }); }
      });
  });
}
async function graphicsHardware(host = {}, { signal, read = readDisplays, now = Date.now, requireName = false } = {}) {
  signal?.throwIfAborted();
  if (host.gpuInfo) return { physicalAppleGPU: host.physicalAppleGPU ?? physicalAppleGpu(host.gpuInfo), gpuName: gpuName(host.gpuInfo), source: "gpu-info" };
  if ((typeof host.physicalAppleGPU === "boolean" && !requireName) || host.gpuName)
    return { physicalAppleGPU: host.physicalAppleGPU === true, gpuName: host.gpuName || null, source: "provided" };
  const architecture = host.hardwareArch || require("./host-capabilities").getHostCapabilities().hardwareArch;
  if ((architecture !== "arm64" && !requireName) || (host.platform && host.platform !== "darwin")) return { physicalAppleGPU: false, source: "host" };
  if (!cached || now() - cached.at >= CACHE_MS) {
    pending ||= Promise.resolve().then(read).catch(() => ({ physicalAppleGPU: false, source: "unavailable" }))
      .then(value => { cached = { value, at: now() }; return value; }).finally(() => { pending = null; });
    await pending;
  }
  signal?.throwIfAborted();
  return typeof host.physicalAppleGPU === "boolean" ? { ...cached.value, physicalAppleGPU: host.physicalAppleGPU } : cached.value;
}
module.exports = { graphicsHardware, physicalAppleGpu, gpuName,
  __test: { reset: () => { cached = null; pending = null; }, CACHE_MS } };
