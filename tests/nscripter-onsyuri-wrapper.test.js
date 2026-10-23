const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const NscripterModule = require("../src/modules/nscripter/main");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

test("patchOnsyuriJs forces web environment", () => {
  const root = makeTempDir("maclauncher-onsyuri-js-");
  const runtimeRoot = path.join(root, "runtime");
  const wrapperDir = path.join(root, "wrapper");
  try {
    const source = [
      "var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!=\"renderer\";",
      "console.log(\"boot\");"
    ].join("");
    writeFile(path.join(runtimeRoot, "onsyuri.js"), source);
    fs.mkdirSync(wrapperDir, { recursive: true });

    const patchedPath = NscripterModule.__test.patchOnsyuriJs(wrapperDir, runtimeRoot);
    assert.equal(patchedPath, path.join(wrapperDir, "onsyuri.js"));

    const patched = fs.readFileSync(patchedPath, "utf8");
    assert.ok(patched.includes("var ENVIRONMENT_IS_NODE=false;"));
    assert.ok(!patched.includes("globalThis.process"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureOnsyuriHtml uses local JSZip when available", () => {
  const root = makeTempDir("maclauncher-onsyuri-html-");
  const wrapperDir = path.join(root, "wrapper");
  const htmlPath = path.join(root, "onsyuri.html");
  try {
    const html = [
      "<!DOCTYPE html>",
      "<html>",
      "  <head>",
      "    <meta onsyuri_js=\"onsyuri.js\">",
      "    <meta onsyuri_index=\"onsyuri_index.json\">",
      "    <script type=\"text/javascript\" src=\"https://unpkg.com/jszip@3.10.1/dist/jszip.min.js\"></script>",
      "  </head>",
      "  <body></body>",
      "</html>"
    ].join("\n");
    writeFile(htmlPath, html);
    fs.mkdirSync(wrapperDir, { recursive: true });
    writeFile(path.join(wrapperDir, "jszip.min.js"), "/* jszip */");

    const patchedPath = NscripterModule.__test.ensureOnsyuriHtml(wrapperDir, htmlPath);
    assert.equal(patchedPath, path.join(wrapperDir, "maclauncher-onsyuri.html"));

    const patched = fs.readFileSync(patchedPath, "utf8");
    assert.ok(patched.includes("maclauncher:onsyuri-env"));
    assert.ok(patched.includes("maclauncher:onsyuri-devtools"));
    assert.ok(patched.includes("jszip.min.js"));
    assert.ok(!patched.includes("unpkg.com/jszip"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ensureOnsyuriHtml stubs JSZip when missing", () => {
  const root = makeTempDir("maclauncher-onsyuri-html-");
  const wrapperDir = path.join(root, "wrapper");
  const htmlPath = path.join(root, "onsyuri.html");
  try {
    const html = [
      "<!DOCTYPE html>",
      "<html>",
      "  <head>",
      "    <meta onsyuri_js=\"onsyuri.js\">",
      "    <meta onsyuri_index=\"onsyuri_index.json\">",
      "    <script type=\"text/javascript\" src=\"https://unpkg.com/jszip@3.10.1/dist/jszip.min.js\"></script>",
      "  </head>",
      "  <body></body>",
      "</html>"
    ].join("\n");
    writeFile(htmlPath, html);
    fs.mkdirSync(wrapperDir, { recursive: true });

    const patchedPath = NscripterModule.__test.ensureOnsyuriHtml(wrapperDir, htmlPath);
    assert.equal(patchedPath, path.join(wrapperDir, "maclauncher-onsyuri.html"));

    const patched = fs.readFileSync(patchedPath, "utf8");
    assert.ok(patched.includes("maclauncher:onsyuri-env"));
    assert.ok(patched.includes("maclauncher:onsyuri-devtools"));
    assert.ok(!patched.includes("unpkg.com/jszip"));
    assert.ok(patched.includes("JSZip is not bundled"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
