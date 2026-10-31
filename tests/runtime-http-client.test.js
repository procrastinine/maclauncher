const assert = require("node:assert/strict");
const test = require("node:test");
const {gzipSync} = require("node:zlib");
const Transport = require("../src/modules/shared/runtime/upstream-transport");
const AndroidRepositories = require("../src/modules/android/store/repositories");

test("Android repository reads preserve decoding, response bounds and malformed-response failures", async t => {
  const bytes = Buffer.from('{"packages":[]}'), requested = [];
  const answers = {
    "https://f-droid.org/repo/fixture.json": {status: 200, headers: {"content-encoding": "gzip"}, body: gzipSync(bytes)},
    "https://f-droid.org/repo/oversized.json": {status: 200, headers: {}, body: bytes},
    "https://f-droid.org/repo/damaged.json": {status: 200, headers: {"content-encoding": "gzip"}, body: Buffer.from("invalid gzip")}
  };
  t.mock.method(Transport, "fetchUrlBuffer", async (url, options) => {
    requested.push(url);
    if (answers[url].body.length > options.maxBytes) throw new Error(`Download response exceeds the ${options.maxBytes} byte limit.`);
    return answers[url];
  });
  assert.deepEqual(await AndroidRepositories.fetchData("https://f-droid.org/repo/fixture.json"), bytes);
  await assert.rejects(AndroidRepositories.fetchData("https://f-droid.org/repo/oversized.json", {maxBytes: 3}), /too large/);
  // A body that does not decode stays as received, so reading it as JSON fails.
  await assert.rejects(async () => JSON.parse((await AndroidRepositories.fetchData("https://f-droid.org/repo/damaged.json")).toString("utf8")), SyntaxError);
  await assert.rejects(AndroidRepositories.fetchData("https://example.com/repo/other.json"), /unsupported/);
  assert.deepEqual(requested, Object.keys(answers));
});
