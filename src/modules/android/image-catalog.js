const Upstream = require('../shared/runtime/upstream');

const repositories = ['android', 'google_apis', 'google_apis_playstore'];
const locations = repositories.map(name => `https://dl.google.com/android/repository/sys-img/${name}/sys-img2-3.xml`);
function text(value) {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"})[entity]).trim();
}
const member = (xml, name) => new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml)?.[1] || '';
const value = (xml, name) => text(member(xml, name));
function parse(documents) {
  const rows = [];
  for (const document of documents) {
    if (document.text.length > 8 * 1024 ** 2 || /<!DOCTYPE|<!ENTITY/i.test(document.text)) throw Error('The Android image catalog is invalid.');
    for (const match of document.text.matchAll(/<remotePackage\s+([^>]+)>([\s\S]*?)<\/remotePackage>/g)) {
      const packagePath = text(/\bpath="([^"]+)"/.exec(match[1])?.[1] || '');
      const body = match[2], apiLevel = value(body, 'api-level'), abi = value(body, 'abi');
      if (!/^system-images;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+;[A-Za-z0-9._-]+$/.test(packagePath) || !/^\d+$/.test(apiLevel) || !/^[a-z0-9_-]+$/.test(abi)) continue;
      const revision = member(body, 'revision'), parts = ['major','minor','micro'].map(name => value(revision, name) || '0');
      if (parts.some(part => !/^\d+$/.test(part))) continue;
      const version = packagePath.replace(/;/g, '-') + '-r' + parts.join('.');
      const details = { packagePath, apiLevel: Number(apiLevel), abi, licenseUrl: 'https://developer.android.com/studio/terms' };
      for (const archive of member(body, 'archives').matchAll(/<archive(?:\s[^>]*)?>([\s\S]*?)<\/archive>/g)) {
        const host = value(archive[1], 'host-os');if (host && host !== 'macosx') continue;
        const complete = member(archive[1], 'complete'), bytes = Number(value(complete, 'size'));
        const checksum = /<checksum\s+type="(sha1|sha256|sha512)"[^>]*>([^<]+)<\/checksum>/.exec(complete);
        const relative = value(complete, 'url');
        if (!relative || !checksum || !Number.isSafeInteger(bytes) || bytes < 1 || !Upstream.readDigest(text(checksum[2]),checksum[1])) continue;
        const url = new URL(relative, document.url).href;
        rows.push({ version, label: value(body, 'display-name') || packagePath, details,
          files: [{ name: url.split('/').at(-1), url, bytes, digest: text(checksum[2]), algorithm: checksum[1] }] });
      }
    }
  }
  return rows;
}
const source = Upstream.index({ locations, hosts: ['dl.google.com'], parse, allArchitectures: true });
module.exports = { source, parse, locations };
