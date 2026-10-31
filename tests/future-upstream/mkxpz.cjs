// mkxp-z publishes Mac builds as public artifacts of its autobuild workflow,
// downloaded with GitHub's digest and no sign-in.
const { createHash } = require("node:crypto");
const hash = (algorithm, text) => createHash(algorithm).update(text).digest("hex");
const repository = "mkxp-z/mkxp-z", API = `https://api.github.com/repos/${repository}/actions`;
const run = (id, day) => ({ id, name: "Autobuild", status: "completed", conclusion: "success", head_branch: "dev", event: "push",
  path: ".github/workflows/autobuild.yml", head_sha: hash("sha1", `${id}`), run_started_at: `2026-10-${day}T10:00:00Z`, created_at: `2026-10-${day}T10:00:00Z`,
  repository: { full_name: repository }, head_repository: { full_name: repository } });
const artifact = (row, name, index) => ({ id: row.id * 10 + index, name, expired: false, size_in_bytes: 4096 + index,
  digest: "sha256:" + hash("sha256", row.id + name), created_at: row.created_at, expires_at: "2099-01-01T00:00:00Z",
  workflow_run: { id: row.id, head_sha: row.head_sha, head_branch: "dev", repository_id: 1 } });
const names = sha => ["macos.x86_64.standalone", "macos.universal.app", "macos.x86_64.app", "macos.arm64.app", "linux.x86_64", "windows.x86_64"]
  .map(kind => `mkxp-z.${kind}.dev-${sha.slice(0, 7)}`);
function routes(runs, artifactNames = names) {
  return { [`${API}/workflows/autobuild.yml/runs`]: { total_count: runs.length, workflow_runs: runs },
    ...Object.fromEntries(runs.map(row => [`${API}/runs/${row.id}/artifacts`, { total_count: 6,
      artifacts: artifactNames(row.head_sha).map((name, index) => artifact(row, name, index)) }])) };
}
const version = row => `${row.run_started_at.replace(/:/g, "-")}_${row.head_sha}`;
// Refresh scans for the newest successful build, which replaces the listed one.
const current = [run(200, 20)], next = run(300, 29), replaced = version(current[0]);
module.exports = { managers: ["mkxpz"], current: routes(current), scenarios: {
  newVersion: { routes: routes([next, ...current]), version: version(next), usable: true, deleted: replaced },
  // Other packaging and CPU words in the artifact names.
  renamedAsset: { routes: routes([next, ...current], sha => [`mkxp-z-macOS-arm64-app-${sha.slice(0, 7)}`, `mkxp-z-macOS-x64-app-${sha.slice(0, 7)}`]),
    version: version(next), usable: true, deleted: replaced },
  // A newest run without a Mac app or with an unreadable artifact list is skipped.
  missingArtifacts: { routes: { ...routes([next, ...current]), [`${API}/runs/${next.id}/artifacts`]: { status: 404, headers: {}, body: Buffer.from("Not Found") } },
    version: replaced, usable: true }
} };
