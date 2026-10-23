import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {sourceInventory, sourceIdentity} from "../src/modules/android/native/build-sources.mjs";
import Content from "./runtime-content.cjs";

/** Staging consumes the completed build snapshot, including recorded shared
 * ART adapters, independently of later changes in the source checkout. */
export function verifyAndroidSourceSnapshot(buildSource, receipt) {
  const buildTools = path.join(buildSource, "build-tools");
  if (receipt.artSources !== undefined && !Array.isArray(receipt.artSources))
    throw new Error("Android build source identity is invalid.");
  // Earlier receipts did not consume a separate ART source closure.
  const artSources = receipt.artSources === undefined ? [] : sourceInventory(path.join(buildSource, "art"));
  const identity = sourceIdentity(sourceInventory(path.join(buildSource, "native")),
    fs.readFileSync(path.join(buildSource, "profile.js")),
    fs.existsSync(buildTools) ? sourceInventory(buildTools) : [], artSources);
  if (identity.sourceHash !== receipt.sourceHash ||
      ["ownedSources", "buildToolsSources", "artSources"].some(name =>
        JSON.stringify(identity[name]) !== JSON.stringify(receipt[name])))
    throw new Error("Android build source identity is invalid.");
  return identity;
}

/** Keep the producer's original relative imports in the corresponding source. */
export function copyAndroidSourceSnapshot(buildSource, identity, sources, copy) {
  for (const [name, input, output] of [
    ["ownedSources", "native", "src/modules/android/native"],
    ["buildToolsSources", "build-tools", ""],
    ["artSources", "art", "src/modules/android/art"]
  ]) for (const item of identity[name] || [])
    if (!Content.excludedReason(item.path))
      copy(path.join(buildSource, input, item.path), path.join(sources, output, item.path));
  copy(path.join(buildSource, "profile.js"), path.join(sources, "src/modules/android/profile.js"));
}

/** Export the pinned production source and license closure without unused
 * test trees. Literal path exclusions preserve other upstream helper names. */
export function archiveAndroidUpstreamSource(checkout, revision, archive) {
  const members = execFileSync("git", ["-C", checkout, "ls-tree", "-r", "--name-only", "-z", revision],
    {encoding:"utf8", maxBuffer:32 * 1024 ** 2}).split("\0").filter(Boolean);
  const excluded = new Set();
  for (const member of members) {
    const parts = member.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      if (!Content.excludedReason(prefix)) continue;
      excluded.add(prefix);
      break;
    }
  }
  execFileSync("git", ["-C", checkout, "archive", "--format=tar", "--output=" + archive, revision,
    "--", ".", ...[...excluded].sort().map(member => ":(exclude,literal)" + member)], {timeout:60000});
  return {sourceMembers:members.length, excludedMembers:[...excluded].sort()};
}

/** Archive an owned publication tree with stable owner and timestamp metadata. */
export function archiveAndroidSourceTree(sources, archive) {
  const normalize = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) normalize(file);
      else if (entry.isSymbolicLink()) fs.lutimesSync(file, 0, 0);
      else fs.utimesSync(file, 0, 0);
    }
    fs.utimesSync(directory, 0, 0);
  };
  normalize(sources);
  execFileSync("/usr/bin/tar", ["--uid", "0", "--gid", "0", "--uname", "root", "--gname", "wheel",
    "--options", "gzip:!timestamp", "-czf", archive, "-C", sources, ...fs.readdirSync(sources).sort()],
    {timeout:60000, maxBuffer:32 * 1024 ** 2});
}

/** Corresponding source can arrive as a pinned release archive as well as Git.
 * Repack only when unused test/generated entries are present; the authenticated
 * original stays unchanged and production helpers keep their original bytes. */
export function filterAndroidSourceArchive(input, output) {
  if (path.resolve(input) === path.resolve(output)) throw new Error("Source publication requires a new archive.");
  const members = execFileSync("/usr/bin/tar", ["-tf", input],
    {encoding:"utf8", maxBuffer:32 * 1024 ** 2}).split("\n").filter(Boolean);
  const excluded = members.filter(member => Content.excludedReason(member));
  if (!excluded.length) fs.copyFileSync(input, output);
  else {
    const escape = member => member.replace(/[\\*?\[\]]/g, value => "\\" + value);
    const format = output.endsWith(".gz") ? "-czf" : output.endsWith(".bz2") ? "-cjf" : output.endsWith(".xz") ? "-cJf" : "-cf";
    execFileSync("/usr/bin/tar", [format, output, ...(format === "-czf" ? ["--options", "gzip:!timestamp"] : []),
      ...excluded.flatMap(member => ["--exclude", escape(member)]), "@" + input],
      {timeout:60000, maxBuffer:32 * 1024 ** 2});
  }
  const published = execFileSync("/usr/bin/tar", ["-tf", output],
    {encoding:"utf8", maxBuffer:32 * 1024 ** 2}).split("\n").filter(Boolean);
  if (published.some(member => Content.excludedReason(member))) throw new Error("Source archive contains test or generated inputs.");
  return {sourceMembers:members.length, publishedMembers:published.length, excludedMembers:excluded};
}
