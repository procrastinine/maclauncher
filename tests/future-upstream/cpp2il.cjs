// Cpp2IL publishes its Mac tools as GitHub Actions artifacts that expire.
const { createHash } = require("node:crypto");
const hash = (algorithm, text) => createHash(algorithm).update(text).digest("hex");
const repository = "SamboyCoding/Cpp2IL", API = `https://api.github.com/repos/${repository}/actions`;
const run = (id, day) => ({ id, name: "dotnet-core", status: "completed", conclusion: "success", head_branch: "development", event: "push",
  path: ".github/workflows/dotnet-core.yml", head_sha: hash("sha1", `${id}`), created_at: `2026-10-${day}T10:00:00Z`, run_number: id,
  repository: { full_name: repository }, head_repository: { full_name: repository } });
const artifact = (runRow, name, index, extra = {}) => ({ id: runRow.id * 10 + index, name, size_in_bytes: 4096 + index, expired: false,
  digest: "sha256:" + hash("sha256", runRow.id + name), created_at: runRow.created_at, expires_at: "2099-01-01T00:00:00Z",
  workflow_run: { id: runRow.id, head_sha: runRow.head_sha, head_branch: "development", repository_id: 1 }, ...extra });
const names = ["Cpp2IL-net9-osx-arm64", "Cpp2IL-net9-osx-x64", "Cpp2IL-net9-linux-x64", "Cpp2IL-net9-win-x64"];
function routes(runs, artifactsOf = row => names.map((name, index) => artifact(row, name, index))) {
  return { [`${API}/workflows/dotnet-core.yml/runs`]: { total_count: runs.length, workflow_runs: runs },
    ...Object.fromEntries(runs.map(row => [`${API}/runs/${row.id}/artifacts`, { total_count: 4, artifacts: artifactsOf(row) }])) };
}
const version = (row, index) => `${row.created_at.slice(0, 10)}-${row.head_sha.slice(0, 12)}-${row.id * 10 + index}`;
const cpu = process.arch === "x64" ? 1 : 0, current = [run(200, 20)], next = run(300, 29);
module.exports = { managers: ["cpp2il"], current: routes(current), scenarios: {
  newVersion: { routes: routes([next, ...current]), version: version(next, cpu), usable: true },
  // A later .NET target and Mac word in the artifact names.
  renamedAsset: { routes: routes([next, ...current], row => row === next ? ["Cpp2IL-net11-macos-arm64", "Cpp2IL-net11-macos-x64"]
    .map((name, index) => artifact(row, name, index)) : names.map((name, index) => artifact(row, name, index))), version: version(next, cpu), usable: true },
  addedAsset: { routes: routes([next, ...current], row => [...names, "Cpp2IL-net9-osx-arm64-symbols", "Cpp2IL-net9-linux-arm64"]
    .map((name, index) => artifact(row, name, index))), version: version(next, cpu), usable: true },
  // The newest run's artifacts expired: the earlier build stays listed.
  expiredArtifact: { routes: routes([next, ...current], row => names.map((name, index) => artifact(row, name, index, row === next ? { expired: true } : {}))),
    version: version(current[0], cpu), usable: true },
  // A run whose artifact list is unavailable is skipped.
  missingArtifacts: { routes: { ...routes([next, ...current]), [`${API}/runs/${next.id}/artifacts`]: { status: 404, headers: {}, body: Buffer.from("Not Found") } },
    version: version(current[0], cpu), usable: true }
},
  // The tool is found when the artifact moves it into a folder.
  layout: { write: root => { require("node:fs").writeFileSync(require("node:path").join(root, "Cpp2IL"), "binary"); return "Cpp2IL"; },
    resolve: root => require("../../src/modules/unity/tools/cpp2il-manager").__test.executable(root) } };
