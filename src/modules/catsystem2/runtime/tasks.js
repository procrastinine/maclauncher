const { objectBytes } = require("./frontend-objects");
const { OFFSET } = require("./motion-vm");
const { createBitmap } = require("./bitmap");
const LIMITS = Object.freeze({ tasks: 4096, labelBytes: 1024 });
const TYPES = new Map([[0, "base"], [1, "top"], [2, "plane"], [6, "button"], [12, "kernel"], [15, "image-list"], [34, "front-end"], [54, "m2-plane"]]);

/** Owned engine task handles; they never represent operating-system pointers. */
function createTaskRegistry({ taskId = 1, engineVersion } = {}) {
  if (!Number.isInteger(taskId) || taskId < 1 || taskId > 65535) throw new Error("A bounded KCS root task handle is required.");
  const tasks = new Map([[taskId, { id: taskId, kind: "kernel", parent: null, label: "", bytes: null, exitCode: -1 }]]); let next = taskId + 1;
  function lookup(id, kind) {
    const task = tasks.get(id); if (!task || kind && task.kind !== kind) throw new Error("KCS task handle is absent or incompatible."); return task;
  }
  function create(type, parent, label) {
    if (!TYPES.has(type)) throw new Error(`KCS task type ${type} is unsupported.`);
    if (type === 54 && engineVersion !== "2.6.1.76") throw new Error("This KCS M2 task version is unsupported.");
    if (typeof label !== "string" || Buffer.byteLength(label) > LIMITS.labelBytes || tasks.size >= LIMITS.tasks || next > 65535) throw new Error("KCS task allocation exceeds its limit.");
    lookup(parent); const id = next++, kind = TYPES.get(type), task = { id, kind, parent, label, bytes: ["plane", "m2-plane"].includes(kind) ? objectBytes() : null,
      visible: ["plane", "m2-plane", "button"].includes(kind), width: 0, height: 0, textures: new Map(), exitCode: -1 };
    if (kind === "m2-plane") task.m2 = { model: null, player: null, gain: 0.5, primaryColor: 0xffffffff, secondaryColor: 0xffffffff,
      frame: 0, currentId: -1, pendingId: -1, tone: [100, 100, 100], callbacks: new Map() };
    tasks.set(id, task); return task;
  }
  function plane(id) {
    const task = lookup(id); if (!["plane", "m2-plane"].includes(task.kind)) throw new Error("KCS task handle is absent or incompatible."); return task;
  }
  function remove(id) {
    if (id === taskId) throw new Error("KCS root tasks require session shutdown."); lookup(id);
    for (const task of [...tasks.values()]) if (task.parent === id) remove(task.id); tasks.delete(id);
  }
  function size(id, width, height, mode) {
    const task = plane(id);
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 16384) || width * height > 32 * 1024 * 1024 || mode !== 0)
      throw new Error("KCS plane dimensions or rectangle mode are unsupported.");
    task.width = width; task.height = height; task.rectangleInitialized = true;
  }
  function initializePlane(id, width, height) {
    const task = plane(id);
    // Message29 creates a single 32-bit backing plane; message2a only sizes
    // its rectangle. Initial native pixel contents are not a decoded image.
    if (![width, height].every(value => Number.isInteger(value) && value >= 0 && value <= 16384) || width * height > 32 * 1024 * 1024)
      throw new Error("This CatSystem2 bitmap layout is unsupported.");
    const bitmap = width && height ? createBitmap({ width, height, tileWidth: 256, tileHeight: 256, bpp: 32 }) : null;
    task.surfaceBitmap?.clear(); task.width = width; task.height = height; task.rectangleInitialized = true;
    task.surfaceBitmap = bitmap; task.surfacePixelsKnown = !bitmap; task.surfaceGeneration = (task.surfaceGeneration || 0) + 1;
  }
  function planePresentation(id, mode) {
    const task = plane(id);
    if (!task.surfaceGeneration) throw new Error("KCS plane presentation requires an allocated surface.");
    if (mode !== 0) throw new Error("This KCS plane presentation mode is unsupported.");
    task.presentationMode = mode;
  }
  function planeBlend(id, mode) {
    const task = plane(id);
    if (mode !== 0) throw new Error("This KCS plane blend mode is unsupported.");
    task.blendMode = mode;
  }
  function planeRectangle(id) {
    const task = plane(id);
    if (!task.rectangleInitialized) throw new Error("KCS plane rectangle requires initialized dimensions.");
    return [0, 0, task.width, task.height];
  }
  function priority(id, value) {
    const task = plane(id);
    if (!Number.isFinite(value) || Math.abs(value) > 1e9) throw new Error("KCS plane priority exceeds its range.");
    task.bytes.writeFloatLE(value, OFFSET.base + 8);
  }
  function base(id, x, y, mode) {
    const task = plane(id);
    if (![x, y].every(value => Number.isFinite(value) && Math.abs(value) <= 1048576) || mode !== 0)
      throw new Error("This KCS plane base profile is unsupported.");
    task.bytes.writeFloatLE(x, OFFSET.base); task.bytes.writeFloatLE(y, OFFSET.base + 4);
  }
  function position(id, x, y, z, mode) {
    const task = plane(id);
    if (![x, y, z].every(value => Number.isFinite(value) && Math.abs(value) <= 1048576) || ![0, 1].includes(mode))
      throw new Error("This KCS plane position profile is unsupported.");
    if (task.motion || task.evaluatedBytes) throw new Error("This KCS evaluated plane position is unsupported.");
    // With no attached motion, both native state selectors resolve to the
    // base state. Active evaluated-state precedence needs its own adapter.
    [x, y, z].forEach((value, index) => task.bytes.writeFloatLE(value, OFFSET.position + index * 4)); task.positionMode = mode;
  }
  function matrix(id, bytes, mode) {
    const task = plane(id);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 64 || ![0, 1].includes(mode) ||
        [...Array(16)].some((_, index) => !Number.isFinite(bytes.readFloatLE(index * 4)) || Math.abs(bytes.readFloatLE(index * 4)) > 1048576))
      throw new Error("This KCS plane matrix profile is unsupported.");
    if (task.motion || task.evaluatedBytes) throw new Error("This KCS evaluated plane matrix is unsupported.");
    bytes.copy(task.bytes, 0x24); task.matrixMode = mode;
  }
  function scale(id, x, y, z, mode) {
    const task = plane(id);
    if (![x, y, z].every(value => Number.isFinite(value) && Math.abs(value) <= 256) || ![0, 1].includes(mode))
      throw new Error("This KCS plane scale profile is unsupported.");
    if (task.motion || task.evaluatedBytes) throw new Error("This KCS evaluated plane scale is unsupported.");
    [x, y, z].forEach((value, index) => task.bytes.writeFloatLE(value, OFFSET.scale + index * 4)); task.scaleMode = mode;
  }
  function display(id, value) { plane(id).visible = Boolean(value); }
  function applyM2Variables(id, values) {
    const task = lookup(id, "m2-plane");
    if (!(values instanceof Map) || values.size > 4096) throw new Error("KCS M2 variables exceed their limit.");
    if (task.m2.model !== null || task.m2.player !== null) throw new Error("This KCS M2 model player is unsupported.");
    // Messages21B/21A stop before reset/apply when the native player is absent.
    // No variables or substitute model are created by this unloaded branch.
  }
  function fillPlane(id, color, enabled) {
    const task = plane(id);
    if (!task.rectangleInitialized || !Number.isInteger(color) || color < 0 || color > 0xffffffff || ![0, 1].includes(enabled))
      throw new Error("KCS plane fill requires initialized dimensions and a supported mode.");
    task.fillColor = color; task.fillEnabled = Boolean(enabled);
  }
  function buttonRegion(id, x, y, width, height, priority, receiver) {
    const task = lookup(id, "button"); lookup(receiver);
    if (![x, y, width, height, priority].every(Number.isSafeInteger) || [x, y].some(value => Math.abs(value) > 1e6) ||
        ![width, height].every(value => value >= 1 && value <= 16384) || width * height > 32 * 1024 * 1024)
      throw new Error("KCS button rectangle exceeds its range.");
    task.inputRegion = { x, y, width, height, priority, receiver };
    task.inputState ||= { activity: 0, options87: null, options99: null };
  }
  function buttonInput(id) { const task = lookup(id, "button"); if (!task.inputState) throw new Error("KCS button input region is absent."); return task.inputState; }
  function buttonOption(id, message, value) {
    if (![87, 99].includes(message) || value !== 0) throw new Error("This KCS button input option is unsupported."); buttonInput(id)[`options${message}`] = value;
  }
  function imageListSize(id, width, height) {
    const task = lookup(id, "image-list");
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= 16384) || width * height > 32 * 1024 * 1024)
      throw new Error("KCS image-list dimensions exceed their limit.");
    task.width = width; task.height = height;
    task.bitmap = createBitmap({ width, height, tileWidth: 256, tileHeight: 256, bpp: 32 }); task.renderGeneration = 0;
  }
  function redrawImageList(id) {
    const task = lookup(id, "image-list");
    if (!task.bitmap || !task.width || !task.height) throw new Error("KCS image-list redraw requires initialized dimensions.");
    if (task.textures.size) throw new Error("This KCS populated image-list redraw is unsupported.");
    // An empty authored list has no dirty source rectangles or texture pages.
    // Commit its real sparse surface without allocating a duplicate raster.
    task.renderGeneration++; return task.bitmap;
  }
  return { tasks, create, lookup, remove, size, initializePlane, planePresentation, planeBlend, planeRectangle, priority, base, position, matrix, scale, display, applyM2Variables, fillPlane, buttonRegion, buttonInput, buttonOption, imageListSize, redrawImageList };
}
module.exports = { LIMITS, TYPES, createTaskRegistry };
