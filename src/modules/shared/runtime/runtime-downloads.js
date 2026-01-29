function formatRuntimeDownloadDetail({ version, variant, detail } = {}) {
  if (detail && String(detail).trim()) return String(detail).trim();
  const parts = [];
  if (version) parts.push(`v${version}`);
  if (variant) parts.push(String(variant));
  return parts.join(" · ") || null;
}

function buildRuntimeDownloadMeta({
  label,
  managerId,
  sectionId,
  version,
  variant,
  detail,
  kind,
  dedupeKey
} = {}) {
  const resolvedLabel = String(label || "Download").trim() || "Download";
  const resolvedDetail = formatRuntimeDownloadDetail({ version, variant, detail });
  const dedupeParts = [
    managerId || "",
    sectionId || "",
    version || "",
    variant || ""
  ].filter(Boolean);
  const resolvedDedupeKey =
    String(dedupeKey || "").trim() || (dedupeParts.length ? `runtime:${dedupeParts.join(":")}` : "");
  return {
    label: resolvedLabel,
    detail: resolvedDetail,
    kind: kind || "runtime",
    managerId: managerId || null,
    sectionId: sectionId || null,
    version: version || null,
    variant: variant || null,
    dedupeKey: resolvedDedupeKey || null
  };
}

module.exports = {
  buildRuntimeDownloadMeta,
  formatRuntimeDownloadDetail
};
