const assert = require("node:assert/strict");
const test = require("node:test");
const M = require("../src/modules/rgss/marshal");

// Ruby 2.6 Marshal.dump fixtures; no game classes/scripts are executed to read
// them. GRAPH includes a cycle, shared strings, default Hash, an opaque Table,
// UTF-8 String, repeated Symbol, signed Fixnums, Bignum, Float and Regexp.
const GRAPH = Buffer.from("BAhbEG86C09iamVjdAY6B0B2WwZAB30HOgZ4SSIGYQY6BkVUOgZ5QAlGdToKVGFibGUHAP9JIgpjYWbDqQY7CFQ6CXdvcmQ7C2kBe2n/hGwrCgAAAAAAAAAAQABmCTEuMjVJLwZhAQY7CEY=", "base64");
const ENCODED_OPAQUE = Buffer.from("BAhbCEl1OglCbG9iB4KgBjoNZW5jb2RpbmciDlNoaWZ0X0pJU0AHSSIJdGFpbAY6BkVU", "base64");

test("Marshal inspection preserves custom objects, cycles, symbol/object links and raw encodings", () => {
  const graph = M.parseMarshal(GRAPH);
  const object = graph.nodes.find(node => node.kind === "object");
  assert.equal(M.resolveNode(graph, object.className).bytes.toString(), "Object");
  const cycle = M.resolveNode(graph, object.ivars[0][1]);
  assert.equal(M.resolveNode(graph, cycle.items[0]), cycle);
  const hash = graph.nodes.find(node => node.kind === "hash");
  assert.equal(M.resolveNode(graph, hash.entries[0][1]), M.resolveNode(graph, hash.entries[1][1]));
  assert.equal(M.resolveNode(graph, hash.default).value, false);
  const opaque = graph.nodes.find(node => node.kind === "userdef");
  assert.equal(M.resolveNode(graph, opaque.className).bytes.toString(), "Table");
  assert.deepEqual(opaque.bytes, Buffer.from([0, 255]));
  const report = M.graphReport(graph);
  assert.equal(report.readOnly, true);
  assert.equal(report.nodes.find(node => node.kind === "string" && node.preview === "café").bytesBase64, "Y2Fmw6k=");
  assert.deepEqual(graph.nodes.filter(node => node.kind === "integer").map(node => node.value), [123, -124]);
  assert.equal(report.nodes.find(node => node.kind === "bignum").sign, "+");
  assert.equal(report.nodes.find(node => node.kind === "float").preview, "1.25");
  assert.equal(graph.nodes.find(node => node.kind === "regexp").options, 1);
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.deepEqual(M.replaceStrings(graph, new Map()), GRAPH);
});

test("encoded opaque payload registers after payload ivars, preserving subsequent references", () => {
  const graph = M.parseMarshal(ENCODED_OPAQUE);
  const root = M.resolveNode(graph, graph.streams[0].root);
  const opaque = M.resolveNode(graph, root.items[0]);
  assert.equal(opaque.objectIndex, 2);
  assert.equal(M.resolveNode(graph, root.items[1]), opaque);
  assert.equal(graph.nodes[graph.streams[0].objects[1]].bytes.toString(), "Shift_JIS");
  assert.deepEqual(opaque.bytes, Buffer.from([0x82, 0xa0]));
  assert.deepEqual(M.replaceStrings(graph, new Map()), ENCODED_OPAQUE);
});

test("Marshal supports Structs and multiple independent XP/VX save streams", () => {
  const struct = M.parseMarshal(Buffer.from("BAhTOhRTdHJ1Y3Q6OkZpeHR1cmUHOgZhaQg6BmJJIgZ2BjoGRVQ=", "base64"));
  assert.equal(M.resolveNode(struct, struct.streams[0].root).kind, "struct");
  const multiple = Buffer.from("BAhbBkkiDHByZXZpZXcGOgZFVAQIewY6CWdvbGRpDA==", "base64");
  assert.throws(() => M.parseMarshal(multiple), /Trailing bytes/);
  const graph = M.parseMarshal(multiple, { allowMultiple: true });
  assert.equal(graph.streams.length, 2);
  assert.equal(graph.streams[0].objects.length, 2);
  assert.equal(graph.streams[1].objects.length, 1);
  assert.equal(M.resolveNode(graph, graph.streams[1].root).kind, "hash");
  assert.deepEqual(M.replaceStrings(graph, new Map()), multiple);
  assert.throws(() => M.parseMarshal(multiple, { allowMultiple: true, maxStreams: 1 }), /Stream count/);
});

test("bounded parser rejects malformed, unsupported hook tags and oversized inputs without code execution", () => {
  for (const tag of ["U", "d", "e", "C", "!"]) assert.throws(() => M.parseMarshal(Buffer.from([4, 8, tag.charCodeAt(0)])), /Unsupported Marshal tag/);
  for (const bytes of [[], [4], [4, 7, 48], [4, 8, 64, 0], [4, 8, 59, 0], [4, 8, 34, 10, 1], [4, 8, 91, 255, 255]]) {
    assert.throws(() => M.parseMarshal(Buffer.from(bytes)), /Truncated|header|reference|negative/);
  }
  assert.throws(() => M.parseMarshal(GRAPH, { maxBytes: 10 }), /byte limit/);
  assert.throws(() => M.parseMarshal(GRAPH, { maxNodes: 5 }), /Node count/);
  assert.throws(() => M.parseMarshal(GRAPH, { maxBlob: 1 }), /Blob exceeds/);
  assert.throws(() => M.parseMarshal(GRAPH, { maxCollection: 2 }), /Collection exceeds/);
  assert.throws(() => M.parseMarshal(Buffer.from([4, 8, 91, 6, 91, 6, 91, 6, 48]), { maxDepth: 1 }), /depth/);
  assert.throws(() => M.parseMarshal(GRAPH, { maxBytes: Infinity }), /Invalid Marshal limit/);
  assert.throws(() => M.parseMarshal(GRAPH, { maxDepth: 99999 }), /Invalid Marshal limit/);
});

test("byte patch preserves opaque bytes and identities while changing a shared String once", () => {
  const graph = M.parseMarshal(GRAPH);
  const originalString = graph.nodes.find(node => node.kind === "string" && node.bytes.toString() === "a");
  const next = M.replaceStrings(graph, new Map([[originalString.id, Buffer.from("a much longer value")]]));
  const patched = M.parseMarshal(next);
  assert.deepEqual(patched.streams[0].objects, graph.streams[0].objects);
  assert.deepEqual(patched.streams[0].symbols, graph.streams[0].symbols);
  const hash = patched.nodes.find(node => node.kind === "hash");
  assert.equal(M.resolveNode(patched, hash.entries[0][1]), M.resolveNode(patched, hash.entries[1][1]));
  assert.equal(M.resolveNode(patched, hash.entries[1][1]).bytes.toString(), "a much longer value");
  assert.deepEqual(patched.nodes.find(node => node.kind === "userdef").bytes, Buffer.from([0, 255]));
  assert.throws(() => M.replaceStrings(graph, new Map([[0, Buffer.from("x")]])), /String node/);
});

test("Marshal signed integer encoding matches independent fixed byte fixtures", () => {
  const cases = [[0, "00"], [122, "7f"], [-123, "80"], [123, "017b"], [-124, "ff84"], [256, "020001"], [-257, "fefffe"], [2147483647, "04ffffff7f"], [-2147483648, "fc00000080"]];
  for (const [value, hex] of cases) {
    assert.equal(M.encodeLong(value).toString("hex"), hex);
    const graph = M.parseMarshal(Buffer.concat([Buffer.from([4, 8, 105]), Buffer.from(hex, "hex")]));
    assert.equal(graph.nodes[0].value, value);
  }
});
