const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const Base = require("./portable-build");
const PIN = require("./portable-build-v3.json");
const FILE = "src/onsyuri/ONScripter.cpp";
const ORIGINAL = `void ONScripter::newPage()
{
    if ( current_page->text_count != 0 ){
        current_page = current_page->next;
        if ( start_page == current_page )
            start_page = start_page->next;
        clearCurrentPage();
    }

    page_enter_status = 0;

    flush( refreshMode(), &sentence_font_info.pos );
}`;
const ADAPTED = ORIGINAL.replace("        clearCurrentPage();\n", "")
  .replace("    page_enter_status = 0;", "    clearCurrentPage();\n    page_enter_status = 0;");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function adaptSource(bytes) {
  if (hash(bytes) !== PIN.sourceGuards[FILE]) throw new Error("Yuri page source differs from its pinned version.");
  const source = bytes.toString("utf8");
  if (source.split(ORIGINAL).length !== 2) throw new Error("Yuri page reset differs from its pinned implementation.");
  return Buffer.from(source.replace(ORIGINAL, ADAPTED));
}

function apply(sourceRoot, sourceDir) {
  Base.requireOwnedSource(sourceRoot, sourceDir);
  const file = path.join(sourceRoot, FILE), original = fs.readFileSync(file), adapted = adaptSource(original);
  fs.writeFileSync(file, adapted);
  return { files: [{ path: FILE, sourceSha256: hash(original), adaptedSourceSha256: hash(adapted) }] };
}

module.exports = { FILE, ORIGINAL, ADAPTED, adaptSource, apply };
