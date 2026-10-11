const assert = require("node:assert/strict");
const test = require("node:test");

async function loadDropPathUtils() {
  return import("../src/renderer/src/ui/drop-path-utils.mjs");
}

test("prioritizeDroppedPaths keeps folder drops when no nested path is present", async () => {
  const { prioritizeDroppedPaths } = await loadDropPathUtils();
  const result = prioritizeDroppedPaths(["/path/to/Games/MyRenpy"]);
  assert.deepEqual(result, ["/path/to/Games/MyRenpy"]);
});

test("prioritizeDroppedPaths prefers nested file paths over parent folders", async () => {
  const { prioritizeDroppedPaths } = await loadDropPathUtils();
  const result = prioritizeDroppedPaths([
    "/path/to/Downloads",
    "/path/to/Downloads/bloonstd4.swf"
  ]);
  assert.deepEqual(result, ["/path/to/Downloads/bloonstd4.swf"]);
});

test("prioritizeDroppedPaths normalizes slash variants for parent detection", async () => {
  const { prioritizeDroppedPaths } = await loadDropPathUtils();
  const result = prioritizeDroppedPaths([
    "C:\\Games\\Folder\\",
    "C:/Games/Folder/game.exe"
  ]);
  assert.deepEqual(result, ["C:/Games/Folder/game.exe"]);
});

