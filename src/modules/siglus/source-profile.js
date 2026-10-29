function realLiveProfile(info) {
  if (info?.engineKind !== "reallive" || info.format !== "RealLive SEEN" ||
    !/^1\.\d+\.\d+\.\d+$/.test(info.detectedVersion || "") ||
    !info.samples?.length || info.samples.some(item => item.headerSize !== 464 || ![10002, 110002, 1110002].includes(item.compilerVersion))) return null;
  const protectedArchive = info.samples.some(item => item.secondaryXor);
  const gameId = info.registryName?.toUpperCase() === "KEY\\CLANNAD_FV" ? "CFV" : null;
  return protectedArchive && !gameId ? null : { version: info.detectedVersion, gameId: protectedArchive ? gameId : null };
}

module.exports = { realLiveProfile };
