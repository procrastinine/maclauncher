const test = require("node:test"), assert = require("node:assert/strict");
const { createActivityDelivery } = require("../src/main/activity-delivery");

test("a paused renderer receives only the newest progress after acknowledging", () => {
  const sent = [];
  const delivery = createActivityDelivery((receiver, message) => sent.push({ receiver, ...message }));
  delivery.ready("library", { downloads: [0] });
  for (let i = 1; i <= 10000; i++) delivery.publish("library", { downloads: [i] });
  assert.equal(sent.length, 1);
  delivery.acknowledge("library", sent[0].sequence);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].activity, { downloads: [10000] });
  delivery.acknowledge("library", sent[0].sequence);
  assert.equal(sent.length, 2, "stale acknowledgements cannot release another message");
  delivery.acknowledge("library", sent[1].sequence);
  delivery.publish("library", { downloads: [] });
  assert.deepEqual(sent[2].activity, { downloads: [] });
});

test("window closure, reload, and full snapshots release stale activity", () => {
  const sent = [], delivery = createActivityDelivery((receiver, message) => sent.push({ receiver, ...message }));
  delivery.ready("one", { running: {} }); delivery.ready("two", { running: {} });
  const first = sent[0].sequence;
  delivery.publish("one", { downloads: ["obsolete"] });
  delivery.supersede("one"); delivery.acknowledge("one", first);
  assert.equal(sent.length, 2);
  delivery.ready("one", { downloads: [] });
  delivery.acknowledge("one", first);
  delivery.publish("two", { downloads: ["unfinished"] });
  delivery.close("two"); delivery.close("one");
  assert.equal(delivery.size, 0);
  delivery.publish("two", { downloads: ["ignored"] });
  delivery.acknowledge("two", sent[1].sequence);
  assert.equal(sent.length, 3);
});

test("failed delivery drops its receiver and retained progress", () => {
  const delivery = createActivityDelivery(() => { throw Error("renderer closed"); });
  delivery.ready({}, { downloads: ["incomplete"] });
  assert.equal(delivery.size, 0);
});
