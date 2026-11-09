// Downloads the videos listed in media.json into public/, where the site serves them.
// The files stay out of Git; each download is checked against its SHA-256.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const website = import.meta.dirname;
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
for (const { file, url, sha256 } of JSON.parse(fs.readFileSync(path.join(website, "media.json"), "utf8"))) {
  const target = path.join(website, file);
  if (fs.existsSync(target) && digest(fs.readFileSync(target)) === sha256) continue;
  const response = await fetch(url);
  if (!response.ok) throw Error(`${url} answered ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (digest(bytes) !== sha256) throw Error(`${url} does not match the SHA-256 recorded for ${file}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
