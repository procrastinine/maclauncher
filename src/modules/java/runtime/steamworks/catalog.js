const Upstream = require("../../../shared/runtime/upstream");
const { compareVersions } = require("../../../shared/runtime/version-order.mjs");

const BASE = "https://repo.maven.apache.org/maven2/com/code-disaster/steamworks4j/steamworks4j/";
function createSource() {
  return Upstream.index({ locations: [BASE + "maven-metadata.xml"], hosts: ["repo.maven.apache.org"], allArchitectures: true,
    parse: async ([metadata], { fetch, latestOnly }) => {
      const versions = [...new Set([...metadata.text.matchAll(/<version>\s*([^<]+?)\s*<\/version>/g)].map(match => match[1]))]
        .filter(version => /^[0-9][0-9A-Za-z._+-]*$/.test(version)).sort((a, b) => compareVersions(b, a));
      const rows = [];
      for (const version of latestOnly ? versions.slice(0, 1) : versions) {
        const name = `steamworks4j-${version}.jar`, url = new URL(`${encodeURIComponent(version)}/${encodeURIComponent(name)}`, BASE).href;
        const headers = await fetch(url, { method: "HEAD" });
        if (headers?.status !== 200) continue;
        let digest;
        for (const [extension, algorithm, pattern] of [["sha256", "sha256", /^[a-f0-9]{64}$/i], ["sha1", "sha1", /^[a-f0-9]{40}$/i]]) {
          const sidecar = await fetch(url + "." + extension);
          const value = sidecar?.status === 200 && sidecar.text.trim().split(/\s+/)[0];
          if (value && pattern.test(value)) { digest = { algorithm, value }; break; }
        }
        rows.push({ version, sourceUrl: BASE, prerelease: /(?:alpha|beta|rc|snapshot)/i.test(version),
          files: [{ name, url, bytes: Number(headers.headers["content-length"]), ...(digest ? { digest } : {}) }] });
      }
      return rows;
    } });
}
module.exports = { BASE, createSource };
