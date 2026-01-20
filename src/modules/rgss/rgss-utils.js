const RTP_IDS = {
  standard: "Standard",
  rpgvx: "RPGVX",
  rpgvxace: "RPGVXAce"
};
const RTP_TO_RGSS = {
  Standard: "RGSS1",
  RPGVX: "RGSS2",
  RPGVXAce: "RGSS3"
};

function normalizeRtpId(value) {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  return RTP_IDS[key] || null;
}

function rgssVersionFromRtpId(value) {
  const rtp = normalizeRtpId(value);
  if (!rtp) return null;
  return RTP_TO_RGSS[rtp] || null;
}

function normalizeRgssVersion(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/rgss\s*([123])/i);
  if (match) return `RGSS${match[1]}`;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 1 && numeric <= 3) {
    return `RGSS${Math.floor(numeric)}`;
  }
  return null;
}

function rgssVersionToNumber(value) {
  if (Number.isFinite(value)) {
    const num = Math.floor(Number(value));
    if (num >= 1 && num <= 3) return num;
    if (num === 0) return 0;
  }
  const normalized = normalizeRgssVersion(value);
  if (!normalized) return 0;
  const parsed = Number(normalized.replace("RGSS", ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function rtpIdToRgssNumber(value) {
  return rgssVersionToNumber(rgssVersionFromRtpId(value));
}

module.exports = {
  normalizeRtpId,
  rgssVersionFromRtpId,
  normalizeRgssVersion,
  rgssVersionToNumber,
  rtpIdToRgssNumber
};
