const assert = require("node:assert/strict");
const test = require("node:test");
const {gzipSync} = require("node:zlib");
const HTTP = require("undici");
const EasyRPG = require("../src/modules/easyrpg/runtime/catalog");
const AndroidRepositories = require("../src/modules/android/store/repositories");

test("runtime lookups use the maintained HTTP client with original HEAD semantics", async t => {
  const previous = HTTP.getGlobalDispatcher(), agent = new HTTP.MockAgent();
  agent.disableNetConnect(); HTTP.setGlobalDispatcher(agent);
  t.after(async () => {HTTP.setGlobalDispatcher(previous); await agent.close();});
  t.mock.method(globalThis, "fetch", () => assert.fail("The embedded HTTP client must not handle runtime lookups"));
  const origin = agent.get("https://easyrpg.org");
  origin.intercept({path: "/fixture.zip", method: "HEAD"}).reply(200, "", {headers: {"content-length": "1234"}});
  origin.intercept({path: "/missing.zip", method: "HEAD"}).reply(404);
  assert.deepEqual(await EasyRPG.headArtifact("https://easyrpg.org/fixture.zip"), {bytes: 1234});
  assert.equal(await EasyRPG.headArtifact("https://easyrpg.org/missing.zip"), null);
  agent.assertNoPendingInterceptors();
});

test("Android repository reads preserve decoding, response bounds and malformed-response failures", async t => {
  const previous = HTTP.getGlobalDispatcher(), agent = new HTTP.MockAgent();
  agent.disableNetConnect(); HTTP.setGlobalDispatcher(agent);
  t.after(async () => {HTTP.setGlobalDispatcher(previous); await agent.close();});
  t.mock.method(globalThis, "fetch", () => assert.fail("The embedded HTTP client must not read repository responses"));
  const origin = agent.get("https://f-droid.org"), bytes = Buffer.from('{"packages":[]}');
  origin.intercept({path: "/repo/fixture.json"}).reply(200, gzipSync(bytes), {headers: {"content-encoding": "gzip"}});
  origin.intercept({path: "/repo/oversized.json"}).reply(200, bytes);
  origin.intercept({path: "/repo/damaged.json"}).reply(200, "invalid gzip", {headers: {"content-encoding": "gzip"}});
  assert.deepEqual(await AndroidRepositories.fetchData("https://f-droid.org/repo/fixture.json"), bytes);
  await assert.rejects(AndroidRepositories.fetchData("https://f-droid.org/repo/oversized.json", {maxBytes: 3}), /too large/);
  await assert.rejects(AndroidRepositories.fetchData("https://f-droid.org/repo/damaged.json"));
  agent.assertNoPendingInterceptors();
});
