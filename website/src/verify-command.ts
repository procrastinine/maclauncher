// The worked verification example on the FAQ page. It is read from the
// "Verify an app" step in docs/development/VERIFYING.md at build time, so the
// site always shows the guide's exact command.
import fs from "node:fs";
import path from "node:path";

// Astro builds from the website directory, beside the repository's docs.
const SOURCE = path.resolve(process.cwd(), "../docs/development/VERIFYING.md");

/** The `commit=` line and the first `gh attestation verify` command for the app archive. */
export function verifyCommand() {
  const lines = fs.readFileSync(SOURCE, "utf8").split("\n").map(line => line.trim());
  const start = lines.findIndex(line => line.startsWith("gh attestation verify MacLauncher.app.zip"));
  const commit = lines.slice(0, start).reverse().find(line => line.startsWith("commit="));
  if (start < 0 || !commit) throw new Error("docs/development/VERIFYING.md no longer shows the app's gh attestation verify command.");
  let end = start;
  while (lines[end].endsWith("\\")) end++;
  return [commit, ...lines.slice(start, end + 1).map((line, index) => index ? `  ${line}` : line)].join("\n");
}

/** The same command as a fenced block, for the site's Markdown copies. */
export const verifyCommandMarkdown = () => "```sh\n" + verifyCommand() + "\n```";
