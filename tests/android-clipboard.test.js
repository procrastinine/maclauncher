const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { create } = require("../src/modules/android/clipboard");

test("one clipboard helper owns enrolled processes, bounded requests and retirement", { timeout: 5000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "android-clipboard-ipc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const helper = path.join(root, "helper"), children = [];
  fs.writeFileSync(helper, `#!${process.execPath}
const enrolled=new Set();
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);
  if(request.op==='enroll')enrolled.add(request.pid);
  if(request.op==='retire')enrolled.delete(request.pid);
  if(request.op!=='transfer'||request.text==='pending')return;
  process.stdout.write(JSON.stringify({id:request.id,allowed:enrolled.has(request.pid),text:'fixture λ\\ntext'})+'\\n');
});
`, { mode: 0o700 });
  const broker = create(helper, { onSpawn: child => children.push(child) });
  t.after(() => broker.close());
  assert.deepEqual(await broker.transfer(101, "paste"), { allowed: false });
  assert.equal(children.length, 0);
  broker.enroll(101); broker.enroll(202); broker.enroll(101);
  assert.equal(children.length, 1);
  assert.deepEqual(await broker.transfer(101, "paste"), { allowed: true, text: "fixture λ\ntext" });
  assert.deepEqual(await broker.transfer(202, "copy", "selection"), { allowed: true, text: "" });
  const pending = broker.transfer(101, "copy", "pending");
  assert.deepEqual(await broker.transfer(101, "paste"), { allowed: false });
  broker.retire(101);
  assert.deepEqual(await pending, { allowed: false });
  assert.deepEqual(await broker.transfer(101, "paste"), { allowed: false });
  broker.enroll(101);
  assert.deepEqual(await broker.transfer(101, "paste"), { allowed: true, text: "fixture λ\ntext" });
  const cancelled = new AbortController(), transfer = broker.transfer(202, "copy", "pending", { signal: cancelled.signal });
  cancelled.abort(); assert.deepEqual(await transfer, { allowed: false });
  const closing = broker.transfer(101, "copy", "pending");
  await broker.close(); assert.deepEqual(await closing, { allowed: false });
  assert.equal(children[0].exitCode, 0);
  assert.equal(children.length, 1, "Transfers share a helper instead of spawning per keypress");
  broker.enroll(303); assert.deepEqual(await broker.transfer(303, "paste"), { allowed: false });
});
