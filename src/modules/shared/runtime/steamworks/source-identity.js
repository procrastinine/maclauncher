const GIT_REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function sourceIdentity(value) {
  if (!value || typeof value !== "object") return null;
  const kind = value.sourceKind ?? "git";
  if (kind === "owned") {
    if (!SHA256.test(value.sourceSha256 || "") || value.sourceRevision != null) return null;
    return { kind, sha256: value.sourceSha256 };
  }
  if (kind !== "git" || !GIT_REVISION.test(value.sourceRevision || "") || value.sourceSha256 != null) return null;
  return { kind, revision: value.sourceRevision };
}

function sameSourceIdentity(left, right) {
  const a = sourceIdentity(left), b = sourceIdentity(right);
  return Boolean(a && b && a.kind === b.kind &&
    (a.kind === "owned" ? a.sha256 === b.sha256 : a.revision === b.revision));
}

function sourceFields(value) {
  const identity = sourceIdentity(value);
  if (!identity) throw new Error("The Steam API source identity is invalid.");
  return identity.kind === "owned"
    ? { sourceKind: "owned", sourceSha256: identity.sha256, sourceRevision: null }
    : { sourceRevision: identity.revision };
}

module.exports = { sourceIdentity, sameSourceIdentity, sourceFields };
