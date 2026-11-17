// Homebrew's formula metadata names the current Vulkan-Loader version and one
// bottle per macOS release and CPU. Each bottle is a GHCR blob that GitHub
// Packages serves with an anonymous pull token.
const FORMULA = "https://formulae.brew.sh/api/formula/vulkan-loader.json";
const blob = digest => `https://ghcr.io/v2/homebrew/core/vulkan-loader/blobs/sha256:${digest}`;
function routes(version, bottles) {
  const files = Object.fromEntries(Object.entries(bottles).map(([name, digest]) => [name, { cellar: ":any", url: blob(digest), sha256: digest }]));
  const result = { [FORMULA]: { name: "vulkan-loader", versions: { stable: version }, bottle: { stable: { rebuild: 0, files } } },
    "https://ghcr.io/token": { token: "fixture-token" } };
  for (const digest of Object.values(bottles)) result[blob(digest)] = { status: 200, body: Buffer.alloc(0), headers: { "content-length": "65536" } };
  return result;
}
const current = { arm64_tahoe: "a".repeat(64), arm64_sequoia: "b".repeat(64), tahoe: "c".repeat(64), sonoma: "d".repeat(64) };

module.exports = {
  managers: ["vulkan-loader"],
  current: routes("1.4.328", current),
  scenarios: {
    newVersion: { routes: routes("1.4.330", { ...current, arm64_tahoe: "e".repeat(64), tahoe: "f".repeat(64) }), version: "1.4.330", usable: true, deleted: "1.4.328" },
    // A new macOS release name not yet known to MacLauncher is used only when no known one is listed.
    renamedBottles: { routes: routes("1.4.328", { arm64_futureos: "1".repeat(64), arm64_tahoe: current.arm64_tahoe, tahoe: current.tahoe }), version: "1.4.328", usable: true },
    // Homebrew rebuilt the bottle behind the same version: the new digest applies.
    replacedFile: { routes: routes("1.4.328", { arm64_tahoe: "2".repeat(64), arm64_sequoia: "3".repeat(64), tahoe: "4".repeat(64), sonoma: "5".repeat(64) }),
      version: "1.4.328", usable: true, digests: ["2", "3", "4", "5"].map(digit => digit.repeat(64)) }
  }
};
