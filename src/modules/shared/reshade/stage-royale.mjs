import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const SOURCE_REVISION = "7ca7f7cbb7e7d016ca1756d0855879c3b7d0cc05";
export const SOURCE_PATH = "src/external/reshade-crt-royale";
export function stageRoyale(source = path.resolve(SOURCE_PATH)) {
  source = path.resolve(source);
  const git = args => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
  if (git(["rev-parse", "HEAD"]) !== SOURCE_REVISION || git(["status", "--porcelain", "--untracked-files=no"]))
    throw new Error("CRT Royale source must match its unmodified pinned revision.");
  const paths = git(["ls-files"]).split("\n").filter(file => ["LICENSE.TXT", "README.MD"].includes(file) ||
    /^reshade-shaders\/Shaders\/(?:crt-royale\.fx|crt-royale\/[A-Za-z0-9/-]+\.fxh)$/.test(file));
  if (!paths.includes("LICENSE.TXT") || !paths.includes("reshade-shaders/Shaders/crt-royale.fx")) throw new Error("CRT Royale sources are incomplete.");
  const destination = path.join(import.meta.dirname, "shader-collection/crt-royale"), files = [];
  for (const original of paths.sort()) {
    const from = path.join(source, original), relative = original.replace(/^reshade-shaders\//, ""), to = path.join(destination, relative);
    const stat = fs.lstatSync(from);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("CRT Royale input must be a regular source file.");
    const bytes = fs.readFileSync(from), sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to) && !fs.readFileSync(to).equals(bytes)) throw new Error("Existing CRT Royale source differs from its pin.");
    fs.writeFileSync(to, bytes, { mode: 0o644 });
    files.push({ path: relative, sourcePath: original, size: bytes.length, sha256 });
  }
  const inventory = { schemaVersion: 1, repository: "https://github.com/akgunter/crt-royale-reshade", revision: SOURCE_REVISION,
    license: "GPL-2.0-or-later and MIT", licensePaths: ["LICENSE.TXT", "Shaders/crt-royale/lib/blur-functions.fxh",
      "Shaders/crt-royale/lib/gamma-management.fxh", "Shaders/crt-royale/lib/helper-functions-and-macros.fxh",
      "Shaders/crt-royale/lib/quad-pixel-communication.fxh", "Shaders/crt-royale/lib/special-functions.fxh"], files };
  fs.writeFileSync(path.join(destination, "source-files.json"), JSON.stringify(inventory, null, 2) + "\n");
  return { destination, files: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0), revision: SOURCE_REVISION };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(stageRoyale(process.argv[2])));
