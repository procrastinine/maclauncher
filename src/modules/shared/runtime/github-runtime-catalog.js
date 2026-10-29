const Github = require("./github-releases");

function githubAssetDigest(asset) {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset?.digest || "");
  return match ? match[1].toLowerCase() : null;
}
function createGithubReleaseDiscovery({ owner, repo, mapRelease, assetFilter, includePrerelease = false, maxPages = 5, maxEntries = 500, dependencies = {} }) {
  if (typeof mapRelease !== "function") throw new Error("GitHub runtime catalogs need an engine release mapper.");
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20 || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 2000)
    throw new Error("GitHub runtime catalog limits must use 1–20 pages and 1–2000 entries.");
  return async ({ logger, signal } = {}) => {
    const [releases, tags] = await Promise.all([
      (dependencies.fetchGithubReleases || Github.fetchGithubReleases)({ owner, repo, logger, signal, includePrerelease, maxPages, assetFilter, ...(dependencies.request ? { request: dependencies.request } : {}) }),
      (dependencies.fetchGithubTags || Github.fetchGithubTags)({ owner, repo, signal, maxPages, ...(dependencies.request ? { request: dependencies.request } : {}) })
    ]);
    const tagCommits = new Map(tags.map(tag => [tag.name, tag.commit.sha]));
    const revisions = new Map();
    const resolveRevision = release => {
      const tag = release.tag_name;
      if (tagCommits.has(tag)) return Promise.resolve(tagCommits.get(tag));
      if (!revisions.has(tag)) revisions.set(tag, (dependencies.resolveGithubTagCommit || Github.resolveGithubTagCommit)({ owner, repo, tag, signal, ...(dependencies.request ? { request: dependencies.request } : {}) }));
      return revisions.get(tag);
    };
    const entries = [];
    // Mappers only select engine-specific versions/assets. Pagination, draft and
    // prerelease policy, release bounds and commit lookups stay shared.
    for (const release of releases) {
      const mapped = await mapRelease(release, { owner, repo, resolveRevision, githubAssetDigest,
        sourceUrl: release.html_url || `https://github.com/${owner}/${repo}/releases/tag/${encodeURIComponent(release.tag_name)}` });
      for (const entry of Array.isArray(mapped) ? mapped : mapped ? [mapped] : []) {
        entries.push(entry);
        if (entries.length >= maxEntries) break;
      }
      if (entries.length >= maxEntries) break;
    }
    return entries;
  };
}
function githubCommitSource(commit, { owner, repo, head = false } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner || "") || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo || "") ||
    !/^[a-f0-9]{40}$/i.test(commit?.sha || "")) throw new Error("GitHub source snapshots need a repository and exact commit.");
  const revision = commit.sha.toLowerCase(), rawDate = commit.commit?.committer?.date;
  const committedAt = typeof rawDate === "string" && Number.isFinite(Date.parse(rawDate)) ? new Date(rawDate).toISOString() : null;
  const subject = String(commit.commit?.message || "").split(/\r?\n/, 1)[0].replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 180);
  return { kind: "github-commit", repository: `${owner}/${repo}`, revision, version: `git-${revision}`,
    url: `https://codeload.github.com/${owner}/${repo}/zip/${revision}`, archivePrefix: `${repo}-${revision}/`,
    sourceUrl: `https://github.com/${owner}/${repo}/commit/${revision}`, committedAt, publishedAt: committedAt, subject, head,
    versionLabel: [head ? "HEAD" : null, committedAt?.slice(0, 10), revision.slice(0, 12)].filter(Boolean).join(" · ") };
}
function createGithubCommitDiscovery({ owner, repo, mapCommit = githubCommitSource, limit = 20, dependencies = {} }) {
  if (typeof mapCommit !== "function") throw new Error("GitHub source catalogs need a commit mapper.");
  return async ({ logger, signal } = {}) => {
    logger?.info?.(`[github] fetching immutable source builds ${owner}/${repo}`);
    const commits = await (dependencies.fetchGithubCommits || Github.fetchGithubCommits)({ owner, repo, signal, limit, ...(dependencies.request ? { request: dependencies.request } : {}) });
    const entries = [];
    for (const [index, commit] of commits.entries()) {
      const mapped = await mapCommit(commit, { owner, repo, head: index === 0, sourceUrl: commit.html_url || `https://github.com/${owner}/${repo}/commit/${commit.sha}` });
      if (mapped) entries.push(mapped);
    }
    return entries;
  };
}
module.exports = { createGithubReleaseDiscovery, createGithubCommitDiscovery, githubCommitSource, githubAssetDigest };
