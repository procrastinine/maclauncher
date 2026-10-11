const test = require("node:test");
const assert = require("node:assert/strict");
const { createGithubActionsDiscovery, nightlyArtifactUrl } = require("../src/modules/shared/runtime/github-actions-catalog");
const now = Date.parse("2026-10-10T00:00:00Z"), revision = "a".repeat(40);
function workflow(id = 1) { return { id, status: "completed", conclusion: "success", head_branch: "main", event: "push",
  path: ".github/workflows/build.yml", head_sha: revision, created_at: "2026-10-09T00:00:00Z",
  repository: { full_name: "owner/project" }, head_repository: { full_name: "owner/project" } }; }
function artifact(id = 2, runId = 1) { return { id, name: "native-arm64", expired: false, size_in_bytes: 1024,
  digest: `sha256:${"b".repeat(64)}`, expires_at: "2027-01-01T00:00:00Z",
  workflow_run: { id: runId, head_sha: revision, head_branch: "main" } }; }
function discover(runList, artifactLists, { limit = 1, maxRuns = 5, maxArtifacts = 200, controller } = {}) {
  const calls = [];
  const callback = createGithubActionsDiscovery({ owner: "owner", repo: "project", workflow: "build.yml", limit, maxRuns, maxArtifacts,
    dependencies: { now: () => now, request: async (url, options) => {
      calls.push(url); if (controller) assert.equal(options.signal, controller.signal);
      assert.equal(options.headers.Authorization, undefined);
      const runId = /actions\/runs\/(\d+)\//.exec(url)?.[1], page = Number(new URL(url).searchParams.get("page") || 1);
      return { status: 200, body: Buffer.from(JSON.stringify(runId ? { artifacts: (artifactLists[runId] || []).slice((page - 1) * 100, page * 100) } : { workflow_runs: runList })) };
    } }, mapArtifact: (asset, { run, githubAssetDigest, nightlyArtifactUrl }) => ({ version: `${run.head_sha}-${asset.id}`,
      upstreamRevision: run.head_sha, asset: { url: nightlyArtifactUrl(), sha256: githubAssetDigest(asset) } }) });
  return { callback, calls };
}

test("public Actions discovery uses bounded successful main runs and exact public artifact URLs without authentication", async () => {
  const controller = new AbortController(), { callback, calls } = discover([workflow(), workflow(3)], { 1: [artifact()], 3: [artifact(4, 3)] }, { controller });
  const entries = await callback({ signal: controller.signal });
  assert.equal(entries.length, 1); assert.equal(calls.length, 2); assert.match(calls[0], /per_page=5.*branch=main.*event=push/);
  assert.equal(entries[0].upstreamRevision, revision); assert.equal(entries[0].asset.sha256, "b".repeat(64));
  assert.equal(entries[0].asset.url, "https://nightly.link/owner/project/actions/artifacts/2.zip");
});

test("All versions reads every matching run within the configured bound while Reload keeps one", async () => {
  const runs = [workflow(), workflow(3), workflow(5), workflow(7), workflow(9)];
  const artifacts = { 1: [artifact()], 3: [artifact(4, 3)], 5: [artifact(6, 5)], 7: [artifact(8, 7)], 9: [artifact(10, 9)] };
  const latest = discover(runs, artifacts), all = discover(runs, artifacts);
  assert.equal((await latest.callback({ latestOnly: true })).length, 1);
  assert.equal(latest.calls.length, 2);
  assert.equal((await all.callback({ latestOnly: false })).length, 5);
  assert.equal(all.calls.length, 6);
  assert.equal(all.calls.filter(url => url.includes("/actions/runs/")).length, 5);
});

test("public Actions discovery skips pull requests, foreign repositories and incomplete or changed artifact identities", async () => {
  const invalidRuns = [{ ...workflow(2), event: "pull_request" }, { ...workflow(3), head_branch: "feature" },
    { ...workflow(4), head_repository: { full_name: "fork/project" } }, { ...workflow(5), conclusion: "failure" }];
  const { callback, calls } = discover([...invalidRuns, workflow()], { 1: [
    { ...artifact(10), expired: true }, { ...artifact(11), digest: null }, { ...artifact(12), expires_at: "2026-01-01T00:00:00Z" },
    { ...artifact(13), workflow_run: { id: 1, head_sha: "c".repeat(40), head_branch: "main" } }, artifact()] });
  const entries = await callback(); assert.equal(entries.length, 1); assert.equal(calls.length, 2);
});

test("public Actions discovery can search the next run and bounded artifact pages after missing or expired artifacts", async () => {
  const first = artifact(); first.expired = true;
  const second = Array.from({ length: 100 }, (_, i) => ({ ...artifact(i + 10, 3), expired: true })); second.push(artifact(200, 3));
  const { callback, calls } = discover([workflow(), workflow(3)], { 1: [first], 3: second });
  const entries = await callback(); assert.equal(entries.length, 1); assert.match(entries[0].asset.url, /200\.zip$/);
  assert.equal(calls.length, 4); assert.match(calls.at(-1), /page=2$/);
});

test("public Actions discovery rejects invalid bounds, oversized or failed responses and respects cancellation", async () => {
  const options = { owner: "owner", repo: "project", workflow: "build.yml", mapArtifact: () => null };
  for (const extra of [{ maxRuns: 0 }, { maxArtifacts: 501 }, { limit: 2, maxRuns: 1 }, { workflow: "../build.yml" }, { event: "pull_request" }])
    assert.throws(() => createGithubActionsDiscovery({ ...options, ...extra }), /require|invalid/i);
  assert.throws(() => nightlyArtifactUrl({ owner: "owner", repo: "project", artifactId: -1 }), /identity/);
  for (const response of [{ status: 403, body: Buffer.from("{}") }, { status: 200, body: Buffer.alloc(4 * 1024 * 1024 + 1) },
    { status: 200, body: Buffer.from('{"workflow_runs":{}}') }]) {
    await assert.rejects(createGithubActionsDiscovery({ ...options, dependencies: { request: async () => response } })(), /unavailable|list/);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createGithubActionsDiscovery({ ...options, dependencies: { request: () => assert.fail("Canceled discovery must not fetch") } })({ signal: controller.signal }), { name: "AbortError" });
});
