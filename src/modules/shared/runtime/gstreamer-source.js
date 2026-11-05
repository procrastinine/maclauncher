const path = require("node:path");
const Upstream = require("./upstream");
const { upstreamPins } = require("./pinned-native-manager");
const Architecture = require("./architecture");
const URL_ROOT = "https://gstreamer.freedesktop.org/data/pkg/osx/";

// GStreamer's odd minor series are development releases. Package CPU suffixes
// do not change the publisher's release series.
function developmentRelease(pin) {
  const minor = /^v?\d+\.(\d+)(?:\.|$)/.exec(pin.releaseVersion || pin.upstreamTag || pin.version || "");
  return Boolean(minor && Number(minor[1]) % 2);
}

function links(document) {
  const found = new Map();
  for (const match of document.text.matchAll(/<a\b[^>]*href=["']([^"']+)["']/gi)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), document.url);
      if (url.origin !== new URL(URL_ROOT).origin || !url.pathname.startsWith(new URL(URL_ROOT).pathname) || url.search || url.hash) continue;
      found.set(url.href, url);
    } catch {}
  }
  return [...found.values()];
}
const upstream = Upstream.index({ locations: [URL_ROOT], hosts: ["gstreamer.freedesktop.org"], allArchitectures: true,
  parse: async ([index], { fetch, logger }) => {
    const folders = links(index).filter(url => url.pathname.endsWith("/") && new URL("../", url).href === URL_ROOT);
    const results = await Promise.allSettled(folders.map(async folder => {
      const listing = await fetch(folder.href);
      if (listing?.status !== 200) throw new Error(`GStreamer release listing unavailable: ${folder.pathname}`);
      const assets = links(listing), rows = [];
      for (const asset of assets.filter(url => new URL(".", url).href === folder.href && /^gstreamer-1\.0-.+\.pkg$/i.test(path.posix.basename(url.pathname)) &&
        !/(?:^|[-_.])(?:devel|debug)(?=[-_.]|$)/i.test(path.posix.basename(url.pathname)))) {
        const name = decodeURIComponent(path.posix.basename(asset.pathname));
        const checksum = assets.find(url => url.href === asset.href + ".sha256sum");
        let digest;
        if (checksum) {
          try {
            const response = await fetch(checksum.href);
            digest = response?.status === 200 && response.text.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line))
              .find(match => match && match[2].trim() === name)?.[1];
            if (!digest) logger?.warn?.(`GStreamer checksum metadata is unavailable for ${name}.`);
          } catch (error) { if (error.name === "AbortError") throw error; logger?.warn?.(`GStreamer checksum metadata: ${error.message}`); }
        }
        const version = name.replace(/^gstreamer-1\.0-/i, "").replace(/\.pkg$/i, "");
        rows.push({ version, ...(developmentRelease({ version }) ? { prerelease: true } : {}),
          label: `GStreamer ${name.replace(/^gstreamer-1\.0-/i, "").replace(/\.pkg$/i, "")} runtime`,
          architecture: Architecture.assetArchitecture(name), sourceUrl: folder.href,
          files: [{ name, url: asset.href, ...(digest ? { digest, algorithm: "sha256" } : {}) }] });
      }
      return rows;
    }));
    const aborted = results.find(result => result.status === "rejected" && result.reason.name === "AbortError");
    if (aborted) throw aborted.reason;
    if (folders.length && results.every(result => result.status === "rejected")) throw results[0].reason;
    return results.flatMap(result => {
      if (result.status === "fulfilled") return result.value;
      logger?.warn?.(result.reason.message); return [];
    }).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
  } });

const catalogSource = { id: "upstream", label: "GStreamer macOS runtime", url: URL_ROOT,
  description: "Runtime framework packages published by GStreamer. Development and debug packages are separate.",
  isPrerelease: developmentRelease,
  discover: async options => upstreamPins(await upstream.discover(options)) };
module.exports = { upstream, catalogSource, developmentRelease };
