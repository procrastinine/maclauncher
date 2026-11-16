// The one vocabulary for the CPU of a build, shared by Runtimes, Downloaded
// files, settings, the inspector and consent. Mac code is Apple Silicon, Intel
// or Universal; where a label states that Intel code runs on an Apple Silicon
// Mac, it reads Intel (Rosetta). Windows code is named by its Windows
// architecture: x64, x86, ARM64, or the hybrid ARM64EC and ARM64X forms that
// run beside x64 code. docs/runtimes/README.md#processor-builds
// holds the table.
export function cpuId(value) {
  const text = String(value || "").trim().toLowerCase();
  if (/^(?:x64|x86_64|amd64)$/.test(text)) return "x64";
  if (/^(?:arm64|aarch64|arm64e)$/.test(text)) return "arm64";
  if (/^(?:x86|i386|i686)$/.test(text)) return "x86";
  if (text === "arm64ec" || text === "arm64x") return text;
  return text === "universal" ? "universal" : "";
}

const MAC = { arm64: "Apple Silicon", x64: "Intel", universal: "Universal" };
const WINDOWS = { arm64: "ARM64", arm64ec: "ARM64EC", arm64x: "ARM64X", x64: "x64", x86: "x86" };

// `hostArchitecture` is passed where the label states the build running on
// this Mac; Intel code on Apple Silicon then adds (Rosetta).
export function cpuLabel(value, { windows = false, hostArchitecture = null } = {}) {
  const cpu = cpuId(value);
  if (windows) return WINDOWS[cpu] || "";
  const label = MAC[cpu] || "";
  return cpu === "x64" && cpuId(hostArchitecture) === "arm64" ? `${label} (Rosetta)` : label;
}
