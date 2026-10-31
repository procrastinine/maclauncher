const crypto = require("node:crypto"), fs = require("node:fs"), path = require("node:path");
const Downloads = require("../../src/modules/gamemaker/runtime/butterscotch-downloads");

// Butterscotch publishes AppKit nightlies as GitHub Actions artifacts of its
// build.yml workflow, one per CPU; Reload lists the latest successful run.
const API = "https://api.github.com/repos/ButterscotchRunner/Butterscotch/actions";
const sha = text => crypto.createHash("sha1").update(text).digest("hex");
const digest = text => "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
function run(id, date) {
  return { id, name: "Build", node_id: `WFR_${id}`, head_branch: "main", head_sha: sha(`run ${id}`), path: ".github/workflows/build.yml",
    display_title: "Update runner", run_number: id % 1000, event: "push", status: "completed", conclusion: "success", workflow_id: 182736455,
    created_at: `${date}T06:47:33Z`, updated_at: `${date}T07:12:01Z`, html_url: `https://github.com/ButterscotchRunner/Butterscotch/actions/runs/${id}`,
    repository: { id: 1, full_name: "ButterscotchRunner/Butterscotch" }, head_repository: { id: 1, full_name: "ButterscotchRunner/Butterscotch" } };
}
function artifact(workflowRun, id, name, { replaced = false } = {}) {
  return { id, node_id: `MDg6QXJ0aWZhY3Q${id}`, name, size_in_bytes: 991480, expired: false, digest: digest(`${replaced ? "replaced " : ""}${id}`),
    url: `${API}/artifacts/${id}`, archive_download_url: `${API}/artifacts/${id}/zip`, created_at: workflowRun.created_at, updated_at: workflowRun.updated_at,
    expires_at: "2099-01-01T00:00:00Z", workflow_run: { id: workflowRun.id, repository_id: 1, head_repository_id: 1, head_branch: "main", head_sha: workflowRun.head_sha } };
}
function routes(runs) {
  return { [`${API}/workflows/build.yml/runs`]: { total_count: runs.length, workflow_runs: runs.map(([value]) => value) },
    ...Object.fromEntries(runs.map(([value, artifacts]) => [`${API}/runs/${value.id}/artifacts`, { total_count: artifacts.length, artifacts }])) };
}
const host = process.arch === "x64" ? "x64" : "arm64";
const version = (value, id) => `${value.created_at.slice(0, 10)}-${value.head_sha.slice(0, 12)}-appkit-${host}-${id}`;
const versions = (value, ids) => ids.map(id => `${value.created_at.slice(0, 10)}-${value.head_sha.slice(0, 12)}-appkit-${id % 2 ? "x64" : "arm64"}-${id}`);
const current = run(40071597289, "2026-10-24"), next = run(40171597289, "2026-11-02");
const currentArtifacts = [artifact(current, 12551705864, "butterscotch-appkit-macos-arm64"), artifact(current, 12551705865, "butterscotch-appkit-macos-x86_64"),
  artifact(current, 12551705866, "butterscotch-sdl-linux-x86_64")];
const hostId = host === "x64" ? 12551705865 : 12551705864;
// Reload lists the newest run, so its predecessor's builds leave the list.
const superseded = versions(current, [12551705864, 12551705865]);

module.exports = {
  managers: ["butterscotch"],
  current: routes([[current, currentArtifacts]]),
  scenarios: {
    newVersion: { routes: routes([[next, [artifact(next, 13000000000, "butterscotch-appkit-macos-arm64"), artifact(next, 13000000001, "butterscotch-appkit-macos-x86_64")]], [current, currentArtifacts]]),
      version: version(next, host === "x64" ? 13000000001 : 13000000000), usable: true, deleted: superseded },
    // One universal artifact replaces the per-CPU artifacts.
    renamedAsset: { routes: routes([[next, [artifact(next, 13000000002, "Butterscotch-macOS-universal")]]]),
      version: version(next, 13000000002), usable: true, deleted: superseded },
    addedAsset: { routes: routes([[next, [artifact(next, 13000000000, "butterscotch-appkit-macos-arm64"), artifact(next, 13000000001, "butterscotch-appkit-macos-x86_64"),
      artifact(next, 13000000004, "butterscotch-sdl-macos-arm64"), artifact(next, 13000000006, "butterscotch-appkit-macos-arm64-dsym"),
      artifact(next, 13000000008, "butterscotch-appkit-windows-x64"), artifact(next, 13000000010, "test-results")]]]),
    version: version(next, host === "x64" ? 13000000001 : 13000000000), usable: true, deleted: superseded },
    // A re-uploaded artifact is listed with the digest GitHub now publishes.
    replacedFile: { routes: routes([[current, currentArtifacts.map(item => artifact(current, item.id, item.name, { replaced: true }))]]),
      version: version(current, hostId), usable: true, digests: currentArtifacts.map(item => digest(`replaced ${item.id}`).slice(7)) }
  },
  layout: { write: root => { fs.writeFileSync(path.join(root, "butterscotch"), "runner"); return "butterscotch"; }, resolve: root => Downloads.resolveExecutable(root) }
};
