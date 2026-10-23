const { fetchUrlBuffer, throwIfAborted } = require("./download-utils");
const { githubAssetDigest } = require("./github-runtime-catalog");

const repositoryName = value => /^[A-Za-z0-9_.-]+$/.test(value || "");
const identity = value => Number.isSafeInteger(value) && value > 0;
function nightlyArtifactUrl({ owner, repo, artifactId }) {
  if (!repositoryName(owner) || !repositoryName(repo) || !identity(artifactId)) throw new Error("Invalid public GitHub artifact identity.");
  return `https://nightly.link/${owner}/${repo}/actions/artifacts/${artifactId}.zip`;
}

// Public Actions metadata is unauthenticated. The archive provider is explicit;
// GitHub's own artifact download endpoint may require authentication, whereas
// nightly.link serves identified, unexpired public artifact ZIPs.
function createGithubActionsDiscovery({ owner, repo, workflow, branch = "main", event = "push", mapArtifact,
  limit = 1, maxRuns = 5, maxArtifacts = 200, dependencies = {} }) {
  if (!repositoryName(owner) || !repositoryName(repo) || !/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow || "") ||
    typeof branch !== "string" || !branch || /[\x00-\x1f]/.test(branch) || !["push", "workflow_dispatch"].includes(event) ||
    typeof mapArtifact !== "function") throw new Error("Public GitHub Actions catalogs require a repository, workflow and artifact mapper.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(maxRuns) || maxRuns < limit || maxRuns > 20 ||
    !Number.isInteger(maxArtifacts) || maxArtifacts < 1 || maxArtifacts > 500) throw new Error("Public GitHub Actions catalog limits are invalid.");
  const name = `${owner}/${repo}`;
  return async ({ logger, signal, latestOnly } = {}) => {
    const matchedLimit = latestOnly === false ? maxRuns : limit;
    const request = dependencies.request || fetchUrlBuffer;
    const read = async route => {
      throwIfAborted(signal);
      const response = await request(`https://api.github.com/repos/${owner}/${repo}/${route}`,
        { signal, headers: { "User-Agent": "maclauncher", Accept: "application/vnd.github+json" } });
      throwIfAborted(signal);
      if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > 4 * 1024 * 1024)
        throw new Error(`Public GitHub Actions metadata is unavailable (${response.status}).`);
      return JSON.parse(response.body.toString("utf8"));
    };
    logger?.info?.(`[github] fetching public artifacts ${name}`);
    const data = await read(`actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${maxRuns}&status=success&branch=${encodeURIComponent(branch)}&event=${event}`);
    if (!Array.isArray(data.workflow_runs) || data.workflow_runs.length > maxRuns) throw new Error("Invalid public GitHub workflow list.");
    const entries = [], seenRuns = new Set(), seenArtifacts = new Set();
    let matchedRuns = 0;
    for (const run of data.workflow_runs) {
      if (!identity(run?.id) || seenRuns.has(run.id)) continue;
      seenRuns.add(run.id);
      if (run.status !== "completed" || run.conclusion !== "success" || run.head_branch !== branch || run.event !== event ||
        run.path !== `.github/workflows/${workflow}` || run.repository?.full_name?.toLowerCase() !== name.toLowerCase() ||
        run.head_repository?.full_name?.toLowerCase() !== name.toLowerCase() || !/^[a-f0-9]{40}$/i.test(run.head_sha || "") ||
        !Number.isFinite(Date.parse(run.created_at))) continue;
      const artifacts = [];
      for (let page = 1; page <= Math.ceil(maxArtifacts / 100); page += 1) {
        const list = await read(`actions/runs/${run.id}/artifacts?per_page=100&page=${page}`);
        if (!Array.isArray(list.artifacts) || list.artifacts.length > 100) throw new Error("Invalid public GitHub artifact list.");
        artifacts.push(...list.artifacts.slice(0, maxArtifacts - artifacts.length));
        if (list.artifacts.length < 100 || artifacts.length >= maxArtifacts) break;
      }
      let matched = false;
      for (const artifact of artifacts) {
        if (!identity(artifact?.id) || seenArtifacts.has(artifact.id)) continue;
        seenArtifacts.add(artifact.id);
        if (artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
          artifact.workflow_run?.id !== run.id || artifact.workflow_run.head_sha?.toLowerCase() !== run.head_sha.toLowerCase() ||
          artifact.workflow_run.head_branch !== branch || !githubAssetDigest(artifact) ||
          !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= (dependencies.now || Date.now)()) continue;
        const mapped = await mapArtifact(artifact, { run, sourceUrl: `https://github.com/${owner}/${repo}/commit/${run.head_sha.toLowerCase()}`,
          githubAssetDigest, nightlyArtifactUrl: () => nightlyArtifactUrl({ owner, repo, artifactId: artifact.id }), signal });
        for (const entry of Array.isArray(mapped) ? mapped : mapped ? [mapped] : []) { entries.push(entry); matched = true; }
      }
      if (matched && ++matchedRuns >= matchedLimit) break;
    }
    return entries;
  };
}

module.exports = { createGithubActionsDiscovery, nightlyArtifactUrl };
