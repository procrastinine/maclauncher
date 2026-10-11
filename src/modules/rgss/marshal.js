// Static Ruby Marshal 4.8 reader. It never resolves classes, calls hooks, or
// interprets Ruby. Edges are node IDs so aliases and cycles remain explicit.
const { createHash } = require("node:crypto");

const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxNodes: 250000,
  maxDepth: 256,
  maxCollection: 100000,
  maxBlob: 32 * 1024 * 1024,
  maxStreams: 64
});

function limitsFor(options = {}) {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits)) {
    if (options[key] !== undefined) {
      if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > limits[key]) {
        throw new Error(`Invalid Marshal limit: ${key}. Limits may only be lowered.`);
      }
      limits[key] = options[key];
    }
  }
  return limits;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseMarshal(input, options = {}) {
  if (!Buffer.isBuffer(input)) throw new TypeError("Marshal input must be a Buffer.");
  const limits = limitsFor(options);
  if (input.length > limits.maxBytes) throw new Error("Marshal input exceeds byte limit.");
  let offset = 0;
  const nodes = [];
  const streams = [];
  let objects;
  let symbols;

  function fail(message) {
    throw new Error(`${message} (Marshal offset ${offset}).`);
  }
  function byte() {
    if (offset >= input.length) fail("Truncated input");
    return input[offset++];
  }
  function long() {
    const first = byte();
    const signed = first > 127 ? first - 256 : first;
    if (signed === 0) return 0;
    if (signed > 4) return signed - 5;
    if (signed < -4) return signed + 5;
    let value = 0;
    for (let i = 0; i < Math.abs(signed); i++) value += byte() * 2 ** (8 * i);
    return signed < 0 ? value - 2 ** (8 * -signed) : value;
  }
  function count() {
    const size = long();
    if (size < 0 || size > limits.maxCollection) fail("Collection exceeds limit or has negative size");
    return size;
  }
  function blob(node, size = null) {
    const lengthOffset = offset;
    const length = size === null ? long() : size;
    if (length < 0 || length > limits.maxBlob) fail("Blob exceeds limit or has negative size");
    if (length > input.length - offset) fail("Truncated blob");
    node.lengthOffset = lengthOffset;
    node.dataOffset = offset;
    node.byteLength = length;
    // Slice without copying; the public graph uses base64, never coerces data
    // into JavaScript object keys or loses the original string encoding.
    node.bytes = input.subarray(offset, offset + length);
    offset += length;
  }
  function register(node) {
    node.objectIndex = objects.length;
    objects.push(node.id);
  }
  function pairs(depth) {
    const size = count();
    const result = [];
    for (let i = 0; i < size; i++) result.push([symbol(depth), read(depth)]);
    return result;
  }
  function symbol(depth) {
    const id = read(depth);
    if (resolveNode({ nodes }, id).kind !== "symbol") fail("Expected a symbol");
    return id;
  }
  function read(depth, wrappedUserdef = false) {
    if (depth > limits.maxDepth) fail("Nesting exceeds depth limit");
    if (nodes.length >= limits.maxNodes) fail("Node count exceeds limit");
    const start = offset;
    const tag = String.fromCharCode(byte());
    const node = { id: nodes.length, tag, start };
    nodes.push(node);
    switch (tag) {
      case "0": node.kind = "nil"; node.value = null; break;
      case "T": case "F": node.kind = "boolean"; node.value = tag === "T"; break;
      case "i": node.kind = "integer"; node.value = long(); break;
      case ":":
        node.kind = "symbol";
        blob(node);
        node.symbolIndex = symbols.length;
        symbols.push(node.id);
        break;
      case ";": case "@": {
        node.kind = tag === ";" ? "symbolLink" : "objectLink";
        node.index = long();
        const table = tag === ";" ? symbols : objects;
        if (node.index < 0 || node.index >= table.length) fail("Invalid reference");
        node.target = table[node.index];
        break;
      }
      case "I": {
        node.kind = "ivars";
        node.value = read(depth + 1, true);
        node.ivars = pairs(depth + 1);
        const inner = nodes[node.value];
        // For _dump objects Ruby registers the resulting object only after
        // reading the payload's ivars (which may themselves add objects).
        if (inner.kind === "userdef" && inner.objectIndex === undefined) register(inner);
        break;
      }
      case '"': case "/": case "f": case "c": case "m": case "M":
        node.kind = { '"': "string", "/": "regexp", f: "float", c: "class", m: "module", M: "classOrModule" }[tag];
        register(node);
        blob(node);
        if (tag === "/") node.options = byte();
        break;
      case "l": {
        node.kind = "bignum";
        register(node);
        node.sign = String.fromCharCode(byte());
        if (!["+", "-"].includes(node.sign)) fail("Invalid bignum sign");
        const words = long();
        if (words < 0) fail("Negative bignum size");
        blob(node, words * 2);
        break;
      }
      case "[": {
        node.kind = "array";
        register(node);
        const size = count();
        node.items = [];
        for (let i = 0; i < size; i++) node.items.push(read(depth + 1));
        break;
      }
      case "{": case "}": {
        node.kind = "hash";
        register(node);
        const size = count();
        node.entries = [];
        for (let i = 0; i < size; i++) node.entries.push([read(depth + 1), read(depth + 1)]);
        if (tag === "}") node.default = read(depth + 1);
        break;
      }
      case "o": case "S":
        node.kind = tag === "o" ? "object" : "struct";
        // Objects/Structs reserve an identity before their class symbol.
        register(node);
        node.className = symbol(depth + 1);
        node.ivars = pairs(depth + 1);
        break;
      case "u":
        node.kind = "userdef";
        node.className = symbol(depth + 1);
        blob(node);
        node.opaque = true;
        if (!wrappedUserdef) register(node);
        break;
      default:
        // marshal_load/_load_data and extended/subclass objects need additional
        // identity rules; reject them rather than guess or execute a hook.
        fail(`Unsupported Marshal tag ${JSON.stringify(tag)}`);
    }
    node.end = offset;
    return node.id;
  }

  do {
    if (streams.length >= limits.maxStreams) fail("Stream count exceeds limit");
    const start = offset;
    if (byte() !== 4 || byte() !== 8) fail("Expected Ruby Marshal 4.8 header");
    objects = [];
    symbols = [];
    const root = read(0);
    streams.push({ start, end: offset, root, objects, symbols });
    if (!options.allowMultiple && offset !== input.length) fail("Trailing bytes after Marshal stream");
  } while (offset < input.length);

  return { input, nodes, streams, limits };
}

function resolveNode(graph, id) {
  let node = graph.nodes[id];
  let remaining = graph.nodes.length + 1;
  while (node && ["ivars", "objectLink", "symbolLink"].includes(node.kind)) {
    if (--remaining <= 0) throw new Error("Cyclic Marshal wrappers.");
    node = graph.nodes[node.kind === "ivars" ? node.value : node.target];
  }
  if (!node) throw new Error("Invalid Marshal node ID.");
  return node;
}

function graphReport(graph) {
  return {
    format: "maclauncher-ruby-marshal-graph-v1",
    sha256: sha256(graph.input),
    byteLength: graph.input.length,
    readOnly: true,
    streams: graph.streams,
    nodes: graph.nodes.map(node => {
      const { bytes, ...result } = node;
      if (bytes) {
        result.bytesBase64 = bytes.toString("base64");
        result.bytesSha256 = sha256(bytes);
        if (["string", "symbol", "class", "module", "classOrModule", "float"].includes(node.kind)) {
          result.preview = bytes.subarray(0, 256).toString("utf8");
        }
      }
      return result;
    })
  };
}

function encodeLong(value) {
  if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
    throw new Error("Marshal integer outside signed 32-bit range.");
  }
  if (value === 0) return Buffer.from([0]);
  if (value > 0 && value < 123) return Buffer.from([value + 5]);
  if (value < 0 && value > -124) return Buffer.from([(value - 5) & 255]);
  const bytes = [];
  let remaining = value;
  do {
    bytes.push(remaining & 255);
    remaining >>= 8;
  } while (remaining !== 0 && remaining !== -1);
  return Buffer.from([value < 0 ? (256 - bytes.length) : bytes.length, ...bytes]);
}

// Replace only the length+bytes of existing String nodes. No graph is rebuilt,
// so object/symbol link numbering, class names, ivars, and opaque data survive.
function replaceStrings(graph, replacements) {
  const edits = [];
  for (const [id, bytes] of replacements) {
    const node = graph.nodes[id];
    if (!node || node.kind !== "string" || !Buffer.isBuffer(bytes)) throw new Error("Expected a String node and Buffer replacement.");
    if (bytes.length > graph.limits.maxBlob) throw new Error("Replacement exceeds blob limit.");
    if (bytes.equals(node.bytes)) continue;
    edits.push({ start: node.lengthOffset, end: node.dataOffset + node.byteLength, bytes: Buffer.concat([encodeLong(bytes.length), bytes]) });
  }
  edits.sort((a, b) => a.start - b.start);
  const parts = [];
  let offset = 0;
  let total = graph.input.length;
  for (const edit of edits) {
    if (edit.start < offset) throw new Error("Overlapping Marshal replacements.");
    total += edit.bytes.length - (edit.end - edit.start);
    if (total > graph.limits.maxBytes) throw new Error("Output exceeds byte limit.");
    parts.push(graph.input.subarray(offset, edit.start), edit.bytes);
    offset = edit.end;
  }
  parts.push(graph.input.subarray(offset));
  return Buffer.concat(parts);
}

module.exports = { DEFAULT_LIMITS, limitsFor, parseMarshal, resolveNode, graphReport, encodeLong, replaceStrings, sha256 };
