const XML = require("../startup");
const { formatKernelString, formatKernelBytes } = require("./kernel-format"), Encoding = require("../encoding");
const { tokens } = require("../frontend-parser");
const { createMessageQueue } = require("./message-queue");
const { createDataRecords, encodeStoredData } = require("./data-records");
const { parseCgList, LIMITS: CG_LIMITS } = require("./cg-registry");
/** Small explicit host services established by original KCS v2 handler evidence. */
function createKernelServices({ taskId, engineVersion, authoringMode = false, debuggerState = null, debugOutput = null, canvas, currentBitmap, readAsset, readStoredData, writeStoredData, flagCount, preferenceRecords, taskRegistry, frontEnd, soundConfig = null, externalBytes = 256 * 1024,
  sharedMemory, sharedState, onExitCode, getFrame, flagRanges, assetExists, getPointer, startupOptions, getWindowState } = {}) {
  if (!Number.isInteger(taskId) || taskId < 1 || taskId > 65535 || typeof authoringMode !== "boolean" ||
      !Number.isSafeInteger(externalBytes) || externalBytes < 4096 || externalBytes > 1024 * 1024)
    throw new Error("Bounded CatSystem2 kernel host settings are required.");
  if (sharedMemory != null && (!Buffer.isBuffer(sharedMemory.bytes) || !Buffer.isBuffer(sharedMemory.known) ||
      sharedMemory.bytes.length !== externalBytes || sharedMemory.known.length !== externalBytes || !sharedMemory.known.every(value => value === 0 || value === 1)))
    throw new Error("KCS shared external memory is invalid.");
  if (sharedState != null && (!(sharedState.variables instanceof Int32Array) || sharedState.variables.length < 1 || sharedState.variables.length > 65536 ||
      !(sharedState.strings instanceof Map) || sharedState.strings.size > 1024)) throw new Error("KCS shared game state is invalid.");
  const flags = sharedMemory?.bytes ?? Buffer.alloc(externalBytes), known = sharedMemory?.known ?? Buffer.alloc(externalBytes, 1);
  const state = { taskId, authoringMode, debuggerState, canvas, loopPoints: new Map(), variables: sharedState?.variables ?? null, strings: sharedState?.strings ?? new Map(), soundConfig };
  const messages = createMessageQueue();
  const dataRecords = createDataRecords();
  const cgRecords = new Map(); let nextCgRecord = 0x10000000;
  const dictionaries = new Map(); let nextDictionary = 0x20000000, dictionaryBytes = 0;
  let motionControllers = null;
  function controllers() {
    const version = engineVersion ?? (startupOptions?.profile === "CatSystem2-startup-options-2.6.1.76" ? "2.6.1.76" : null);
    if (!motionControllers) motionControllers = require("./motion-controllers").createMotionControllers({ engineVersion: version });
    return motionControllers;
  }
  function dictionary(id) {
    const value = dictionaries.get(id); if (!value) throw new Error("KCS dictionary handle is invalid."); return value;
  }
  function dictionaryKey(machine, address) {
    const bytes = formatKernelBytes(machine, address);
    if (bytes.length > 2046) throw new Error("KCS dictionary key exceeds its limit.");
    return { key: bytes.toString("hex"), bytes: bytes.length + 4 };
  }
  function cgRecord(id) {
    const value = cgRecords.get(id);
    if (!value) throw new Error("KCS CG registration handle is invalid.");
    return value;
  }
  const argumentsSize = (args, expected) => { if (args.length !== expected) throw new Error("Unsupported KCS native service argument layout."); };
  const documents = new Map(); let nextDocument = 1;
  function documentScalar(machine, args) {
    argumentsSize(args, 12); const id = args.readUInt32LE(0), document = documents.get(id);
    if (id && !document) throw new Error("KCS XML document handle is invalid.");
    const query = formatKernelString(machine, args.readUInt32LE(8));
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*(?:\/[A-Za-z_][A-Za-z0-9_.-]*)*$/.test(query) || query.length > 511) throw new Error("Unsupported KCS XML query path.");
    let current = document;
    for (const name of query.split("/")) {
      const matches = current?.children?.filter(node => node.name === name) || [];
      if (matches.length > 1) throw new Error("KCS XML query is ambiguous.");
      current = matches[0]; if (!current) return null;
    }
    if (current.children.length) throw new Error("KCS XML query requires a scalar node."); return current.text.trim();
  }
  const nativeCalls = new Map([
    [925, ({ arguments: args }) => {
      argumentsSize(args, 0);
      const version = engineVersion ?? (startupOptions?.profile === "CatSystem2-startup-options-2.6.1.76" ? "2.6.1.76" : null);
      if (version !== "2.6.1.76") throw new Error("This KCS native feature query is unsupported.");
      // This version's handler is a literal one; it does not inspect a plugin
      // or create a device. Device operations remain separate native services.
      return { value: 1 };
    }],
    [921, ({ arguments: args }) => {
      argumentsSize(args, 8); const dictionaryId = args.readUInt32LE(4); if (!dictionaryId) return {};
      const values = dictionary(dictionaryId).values;
      if (typeof taskRegistry?.applyM2Variables !== "function") throw new Error("KCS M2 variable application is unavailable.");
      taskRegistry.applyM2Variables(args.readUInt32LE(0), values); return {};
    }],
    [207, ({ machine, arguments: args }) => {
      argumentsSize(args, 4); const address = args.readUInt32LE(0);
      if (!address) throw new Error("The KCS global matrix stack is unsupported.");
      const matrix = Buffer.alloc(64);
      for (let index = 0; index < 16; index++) matrix.writeFloatLE(index % 5 === 0 ? 1 : 0, index * 4);
      machine.writeBytes(address, matrix); return {};
    }],
    [294, ({ arguments: args }) => { argumentsSize(args, 0); return { value: controllers().create() }; }],
    [295, ({ arguments: args }) => { argumentsSize(args, 4); const id = args.readUInt32LE(0); if (id) controllers().remove(id); return {}; }],
    [296, ({ arguments: args }) => { argumentsSize(args, 4); const id = args.readUInt32LE(0); if (id) controllers().clear(id); return {}; }],
    [303, ({ arguments: args }) => { argumentsSize(args, 4); const id = args.readUInt32LE(0); if (id) controllers().restore(id); return {}; }],
    [586, ({ arguments: args }) => { argumentsSize(args, 8); const id = args.readUInt32LE(0); if (id) controllers().setDataMode(id, args.readUInt32LE(4)); return {}; }],
    [5, ({ arguments: args }) => {
      argumentsSize(args, 0);
      if (typeof getFrame !== "function") throw new Error("KCS authored frame clock is unavailable.");
      const frame = getFrame();
      if (!Number.isSafeInteger(frame) || frame < 0 || frame > 1000000) throw new Error("KCS authored frame clock exceeds its range.");
      return { value: frame };
    }],
    [741, ({ arguments: args }) => {
      argumentsSize(args,0); if (typeof getWindowState !== "function") throw new Error("KCS native window state is unavailable.");
      const window=getWindowState(); if (!window || typeof window.windowed !== "boolean") throw new Error("KCS native window state is invalid.");
      // The measured native getter returns zero in windowed mode. Its
      // fullscreen sizing field requires a separately supported contract.
      if (!window.windowed) throw new Error("This KCS fullscreen sizing profile is unsupported.");
      return {value:0};
    }],
    [739, ({ machine, arguments: args }) => {
      argumentsSize(args, 8);
      // Native client-pixel conversion is already performed by the viewport;
      // these are the actual coordinates in the authored canvas.
      if (typeof getPointer !== "function") throw new Error("KCS native pointer state is unavailable.");
      const pointer = getPointer();
      if (!pointer || ![pointer.x, pointer.y].every(value => Number.isInteger(value) && Math.abs(value) <= 1048576))
        throw new Error("KCS native pointer coordinates exceed their range.");
      const output = [pointer.x, pointer.y].map(value => { const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes; });
      machine.resolve(args.readUInt32LE(0), 4, { write: true }); machine.resolve(args.readUInt32LE(4), 4, { write: true });
      output.forEach((bytes, index) => machine.writeBytes(args.readUInt32LE(index * 4), bytes)); return {};
    }],
    [1, ({ machine, arguments: args }) => {
      argumentsSize(args, 4); const bytes = formatKernelBytes(machine, args.readUInt32LE(0));
      if (bytes.length > 2046) throw new Error("KCS debug text exceeds its output limit."); debugOutput?.(Encoding.decode(bytes)); return {};
    }],
    [21, ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const left = machine.stringBytes(args.readUInt32LE(4)), right = machine.stringBytes(args.readUInt32LE(0));
      const lower = byte => byte >= 65 && byte <= 90 ? byte + 32 : byte;
      for (let index = 0; index <= Math.max(left.length, right.length); index++) {
        const difference = lower(left[index] ?? 0) - lower(right[index] ?? 0); if (difference) return { value: difference };
      }
      return { value: 0 };
    }],
    [36, ({ machine, arguments: args }) => {
      argumentsSize(args, 12); const length = args.readUInt32LE(8), range = machine.resolve(args.readUInt32LE(0), length, { write: true });
      range.bytes.fill(args.readUInt32LE(4) & 255, range.offset, range.offset + length); range.didWrite?.(range.offset, length); return {};
    }],
    [41, ({ machine, arguments: args }) => {
      argumentsSize(args, 12); const source = Buffer.from(machine.stringBytes(args.readUInt32LE(4))), separator = machine.stringBytes(args.readUInt32LE(8));
      if (separator.length > 32 || separator.some(byte => byte >= 128)) throw new Error("Unsupported KCS string separator set.");
      Encoding.decode(source); const output = []; let token = false;
      for (let index = 0; index < source.length; index++) {
        const byte = source[index];
        if (separator.includes(byte)) { if (token) output.push(0); token = false; }
        else { output.push(byte); if (byte >= 0x81 && byte <= 0x9f || byte >= 0xe0 && byte <= 0xfc) output.push(source[++index]); token = true; }
      }
      output.push(0, 0); machine.writeBytes(args.readUInt32LE(0), Buffer.from(output)); return {};
    }],
    // The original host sends its optional debugger control window message
    // 0x464; its receiver shows/hides the run control when that window exists.
    [393, ({ arguments: args }) => {
      argumentsSize(args, 4);
      if (state.debuggerState) state.debuggerState.runControlVisible = args.readUInt32LE(0) === 0;
      return {};
    }],
    // Authoring mode controls the program's own source-compilation branch.
    // Normal runtime execution does not enable the original Windows SDK tools.
    [465, ({ arguments: args }) => { argumentsSize(args, 0); return { value: Number(state.authoringMode) }; }],
    [999, ({ arguments: args }) => {
      argumentsSize(args, 0);
      if (startupOptions?.profile !== "CatSystem2-startup-options-2.6.1.76" || typeof startupOptions.get !== "function")
        throw new Error("KCS native startup options are unavailable.");
      const value = startupOptions.get(999);
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error("KCS native startup option exceeds its range.");
      return { value };
    }],
    [68, ({ arguments: args }) => { argumentsSize(args, 0); return { value: state.taskId }; }],
    [71, ({ machine, arguments: args }) => {
      argumentsSize(args, 4); machine.waitMessage(args.readUInt32LE(0)); return { yielded: true };
    }],
    [66, ({ machine, arguments: args }) => {
      argumentsSize(args, 12); if (!taskRegistry?.create) throw new Error("KCS task creation is unavailable.");
      const task = taskRegistry.create(args.readUInt32LE(0), args.readUInt32LE(4), formatKernelString(machine, args.readUInt32LE(8))); return { value: task.id };
    }],
    [67, async ({ arguments: args }) => {
      argumentsSize(args, 4); if (!taskRegistry?.lookup || !taskRegistry.remove) throw new Error("KCS task removal is unavailable.");
      const id = args.readUInt32LE(0), task = taskRegistry.lookup(id);
      if (id === taskId || task.kind === "kernel") throw new Error("This KCS kernel task removal is unsupported.");
      if (task.kind === "front-end") {
        if (!frontEnd?.dispose) throw new Error("KCS front-end removal is unavailable.");
        await frontEnd.dispose(id);
      }
      taskRegistry.remove(id); return {};
    }],
    [79, ({ arguments: args }) => {
      argumentsSize(args, 16); if (!taskRegistry?.size) throw new Error("KCS plane sizing is unavailable.");
      taskRegistry.size(args.readUInt32LE(0), args.readFloatLE(4), args.readFloatLE(8), args.readUInt32LE(12)); return {};
    }],
    [78, ({ arguments: args }) => {
      argumentsSize(args, 12); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.initializePlane !== "function") throw new Error("KCS plane allocation is unavailable.");
      taskRegistry.initializePlane(id, args.readFloatLE(4), args.readFloatLE(8)); return {};
    }],
    [466, ({ arguments: args }) => {
      argumentsSize(args, 8); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.planePresentation !== "function") throw new Error("KCS plane presentation is unavailable.");
      taskRegistry.planePresentation(id, args.readUInt32LE(4)); return {};
    }],
    [402, ({ arguments: args }) => {
      argumentsSize(args, 8);
      if (typeof taskRegistry?.planeBlend !== "function") throw new Error("KCS plane blending is unavailable.");
      taskRegistry.planeBlend(args.readUInt32LE(0), args.readUInt32LE(4)); return {};
    }],
    [88, ({ arguments: args }) => {
      argumentsSize(args, 8); if (!taskRegistry?.priority) throw new Error("KCS plane priority is unavailable.");
      taskRegistry.priority(args.readUInt32LE(0), args.readFloatLE(4)); return {};
    }],
    [85, ({ arguments: args }) => {
      argumentsSize(args, 16); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.base !== "function") throw new Error("KCS plane base coordinates are unavailable.");
      taskRegistry.base(id, args.readFloatLE(4), args.readFloatLE(8), args.readUInt32LE(12)); return {};
    }],
    [84, ({ arguments: args }) => {
      argumentsSize(args, 20); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.position !== "function") throw new Error("KCS plane position is unavailable.");
      taskRegistry.position(id, args.readFloatLE(4), args.readFloatLE(8), args.readFloatLE(12), args.readUInt32LE(16)); return {};
    }],
    [344, ({ machine, arguments: args }) => {
      argumentsSize(args, 12); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.matrix !== "function") throw new Error("KCS plane matrices are unavailable.");
      const source = machine.resolve(args.readUInt32LE(4), 64);
      taskRegistry.matrix(id, source.bytes.subarray(source.offset, source.offset + 64), args.readUInt32LE(8)); return {};
    }],
    [345, ({ machine, arguments: args }) => {
      argumentsSize(args, 20); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.planeRectangle !== "function") throw new Error("KCS plane rectangles are unavailable.");
      const rectangle = taskRegistry.planeRectangle(id);
      if (!Array.isArray(rectangle) || rectangle.length !== 4 || rectangle.some(value => !Number.isFinite(value) || Math.abs(value) > 1048576))
        throw new Error("The KCS plane rectangle exceeds its range.");
      const output = rectangle.map(value => { const bytes = Buffer.alloc(4); bytes.writeFloatLE(value); return bytes; });
      const addresses = [4, 8, 12, 16].map(offset => args.readUInt32LE(offset)); addresses.forEach(address => machine.resolve(address, 4, { write: true }));
      addresses.forEach((address, index) => machine.writeBytes(address, output[index])); return {};
    }],
    [101, ({ arguments: args }) => {
      argumentsSize(args, 20); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.scale !== "function") throw new Error("KCS plane scaling is unavailable.");
      taskRegistry.scale(id, args.readFloatLE(4), args.readFloatLE(8), args.readFloatLE(12), args.readUInt32LE(16)); return {};
    }],
    [92, ({ arguments: args }) => {
      argumentsSize(args, 8); if (!taskRegistry?.display) throw new Error("KCS plane display is unavailable.");
      taskRegistry.display(args.readUInt32LE(0), args.readUInt32LE(4)); return {};
    }],
    [100, ({ arguments: args }) => {
      argumentsSize(args, 12); const id = args.readUInt32LE(0); if (!id) return {};
      if (typeof taskRegistry?.fillPlane !== "function") throw new Error("KCS plane fill is unavailable.");
      taskRegistry.fillPlane(id, args.readUInt32LE(4), args.readUInt32LE(8)); return {};
    }],
    [117, ({ arguments: args }) => {
      argumentsSize(args, 24);
      // The zero-handle branch clears the inherited atlas and does not consume
      // the sixth color word. Direct bitmap handles use another native path.
      if (args.readUInt32LE(0) !== 0) throw new Error("This KCS direct bitmap handle is unsupported.");
      if (typeof currentBitmap?.fill !== "function") throw new Error("KCS bitmap clearing requires the authored texture atlas.");
      currentBitmap.fill(...[4, 8, 12, 16].map(offset => args.readInt32LE(offset)), 0); return {};
    }],
    [256, ({ arguments: args }) => {
      argumentsSize(args, 12); if (!taskRegistry?.imageListSize) throw new Error("KCS image-list sizing is unavailable.");
      taskRegistry.imageListSize(args.readUInt32LE(0), args.readUInt32LE(4), args.readUInt32LE(8)); return {};
    }],
    [342, ({ arguments: args }) => {
      argumentsSize(args, 4); if (!taskRegistry?.redrawImageList) throw new Error("KCS image-list redraw is unavailable.");
      taskRegistry.redrawImageList(args.readUInt32LE(0)); return {};
    }],
    [260, ({ arguments: args }) => {
      argumentsSize(args, 12); if (!taskRegistry?.lookup) throw new Error("KCS image-list state is unavailable.");
      const task = taskRegistry.lookup(args.readUInt32LE(0), "image-list");
      // Message11B stores both controls in the task and its existing allocator.
      // Retain authored values; individual allocation operations still require
      // their own supported bindings and enforce the image-cache limits.
      const controls = [args.readUInt32LE(4), args.readUInt32LE(8)];
      if (controls.some(value => value > 65536)) throw new Error("KCS image-list allocation controls exceed their limit.");
      task.allocationMode = controls; return {};
    }],
    [262, ({ arguments: args }) => {
      argumentsSize(args, 8); if (!taskRegistry?.lookup) throw new Error("KCS image-list state is unavailable.");
      const task = taskRegistry.lookup(args.readUInt32LE(0), "image-list"), mode = args.readUInt32LE(4);
      if (mode > 1) throw new Error("This KCS image-list presentation mode is unsupported."); task.drawMode = mode; return {};
    }],
    [449, ({ arguments: args }) => {
      argumentsSize(args, 8); if (!taskRegistry?.lookup || !state.canvas) throw new Error("KCS front-end image resources are unavailable.");
      const task = taskRegistry.lookup(args.readUInt32LE(0), "front-end"), list = taskRegistry.lookup(args.readUInt32LE(4), "image-list");
      if (!list.width || !list.height) throw new Error("KCS front-end image resources require initialized dimensions.");
      task.imageList = list.id; task.canvas = { ...state.canvas }; return {};
    }],
    [447, async ({ machine, arguments: args }) => {
      argumentsSize(args, 8); if (typeof frontEnd?.load !== "function") throw new Error("KCS authored front-end execution is unavailable.");
      taskRegistry.lookup(args.readUInt32LE(0), "front-end"); await frontEnd.load(args.readUInt32LE(0), formatKernelString(machine, args.readUInt32LE(4))); return {};
    }],
    [448, async ({ arguments: args }) => {
      argumentsSize(args, 4); if (typeof frontEnd?.start !== "function") throw new Error("KCS front-end activation is unavailable.");
      taskRegistry.lookup(args.readUInt32LE(0), "front-end"); await frontEnd.start(args.readUInt32LE(0)); return {};
    }],
    [452, ({ arguments: args }) => {
      argumentsSize(args, 4); if (!taskRegistry?.lookup) throw new Error("KCS task completion state is unavailable.");
      const value = taskRegistry.lookup(args.readUInt32LE(0)).exitCode;
      if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error("KCS task completion state is invalid."); return { value };
    }],
    [453, async ({ arguments: args }) => {
      argumentsSize(args, 4); if (!taskRegistry?.lookup) throw new Error("KCS task completion state is unavailable.");
      const code = args.readInt32LE(0); taskRegistry.lookup(taskId, "kernel").exitCode = code; await onExitCode?.(code); return {};
    }],
    [419, ({ arguments: args }) => {
      argumentsSize(args, 0);
      if (cgRecords.size >= 256 || nextCgRecord >= 0x10010000) throw new Error("KCS CG registration containers exceed their session limit.");
      const id = nextCgRecord++; cgRecords.set(id, { entries: new Map(), list: null }); return { value: id };
    }],
    [894, ({ arguments: args }) => {
      argumentsSize(args, 0);
      if (dictionaries.size >= 256 || nextDictionary >= 0x20010000) throw new Error("KCS dictionaries exceed their session limit.");
      const id = nextDictionary++; dictionaries.set(id, { values: new Map(), bytes: 0 }); return { value: id };
    }],
    [895, ({ arguments: args }) => {
      argumentsSize(args, 4); const id = args.readUInt32LE(0);
      if (id) { dictionaryBytes -= dictionary(id).bytes; dictionaries.delete(id); } return {};
    }],
    [896, ({ machine, arguments: args }) => {
      argumentsSize(args, 12); const id = args.readUInt32LE(0); if (!id) return {};
      const record = dictionary(id), key = dictionaryKey(machine, args.readUInt32LE(4));
      if (!record.values.has(key.key)) {
        if (record.values.size >= 4096 || dictionaryBytes + key.bytes > 8 * 1024 * 1024) throw new Error("KCS dictionary entries exceed their session limit.");
        dictionaryBytes += key.bytes; record.bytes += key.bytes;
      }
      record.values.set(key.key, args.readInt32LE(8)); return {};
    }],
    [897, ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const id = args.readUInt32LE(0); if (!id) return { value: 0 };
      return { value: dictionary(id).values.get(dictionaryKey(machine, args.readUInt32LE(4)).key) ?? 0 };
    }],
    [898, ({ arguments: args }) => {
      argumentsSize(args, 4); const id = args.readUInt32LE(0);
      if (id) { const record = dictionary(id); dictionaryBytes -= record.bytes; record.bytes = 0; record.values.clear(); } return {};
    }],
    [420, ({ arguments: args }) => {
      argumentsSize(args, 4); const id = args.readUInt32LE(0);
      if (id) { cgRecord(id); cgRecords.delete(id); } return {};
    }],
    [421, ({ arguments: args }) => {
      argumentsSize(args, 4); const id = args.readUInt32LE(0);
      // Reset seen-file registrations; the loaded authored list remains bound.
      if (id) cgRecord(id).entries.clear(); return {};
    }],
    [458, async ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const id = args.readUInt32LE(0); if (!id) return {};
      const record = cgRecord(id);
      if (typeof readAsset !== "function") throw new Error("KCS CG lists require a bounded original asset provider.");
      const filename = formatKernelString(machine, args.readUInt32LE(4));
      const parsed = parseCgList(await readAsset(filename, { maximumBytes: CG_LIMITS.bytes }));
      record.list = parsed; return {};
    }],
    [645, ({ arguments: args }) => {
      argumentsSize(args, 12); if (!taskRegistry?.lookup || !frontEnd?.setLocal) throw new Error("KCS front-end locals are unavailable.");
      const id = args.readUInt32LE(0); taskRegistry.lookup(id, "front-end");
      const index = args.readUInt32LE(4); if (index >= 512) throw new Error("KCS front-end local value exceeds its range.");
      frontEnd.setLocal(id, index, args.readInt32LE(8)); return {};
    }],
    [646, ({ arguments: args }) => {
      argumentsSize(args,8); if (!taskRegistry?.lookup || !frontEnd?.getLocal) throw new Error("KCS front-end locals are unavailable.");
      const id=args.readUInt32LE(0); taskRegistry.lookup(id,"front-end");
      const index=args.readUInt32LE(4); if (index>=512) throw new Error("KCS front-end local index exceeds its range.");
      const value=frontEnd.getLocal(id,index); if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error("KCS front-end local value exceeds its range.");
      return {value};
    }],
    [630, async ({ machine, arguments: args }) => {
      argumentsSize(args,16); if (!taskRegistry?.lookup || !frontEnd?.callBlock) throw new Error("KCS front-end callbacks are unavailable.");
      const id=args.readUInt32LE(0); taskRegistry.lookup(id,"front-end");
      const label=formatKernelString(machine,args.readUInt32LE(4)), objectName=formatKernelString(machine,args.readUInt32LE(8)), index=args.readUInt32LE(12);
      await frontEnd.callBlock(id,label,objectName,index); return {};
    }],
    [104, ({ arguments: args }) => {
      argumentsSize(args, 28); if (!taskRegistry?.buttonRegion) throw new Error("KCS button rectangles are unavailable.");
      taskRegistry.buttonRegion(args.readUInt32LE(0), ...[4, 8, 12, 16, 20].map(offset => args.readInt32LE(offset)), args.readUInt32LE(24)); return {};
    }],
    [105, ({ arguments: args }) => {
      argumentsSize(args, 8); if (!taskRegistry?.buttonInput) throw new Error("KCS button input state is unavailable.");
      // The original binding reads its first argument and returns message85's
      // activity word. The second supplied word is not consumed by that binding.
      return { value: taskRegistry.buttonInput(args.readUInt32LE(0)).activity };
    }],
    ...[[848, 87], [849, 99]].map(([id, message]) => [id, ({ arguments: args }) => {
      argumentsSize(args, 8); if (!taskRegistry?.buttonOption) throw new Error("KCS button input options are unavailable.");
      taskRegistry.buttonOption(args.readUInt32LE(0), message, args.readUInt32LE(4)); return {};
    }]),
    [789, ({ arguments: args }) => {
      argumentsSize(args, 0); if (!Number.isInteger(flagCount) || flagCount < 1 || flagCount > 65536) throw new Error("KCS flag count requires authored startup settings."); return { value: flagCount };
    }],
    [790, ({ machine, arguments: args }) => {
      argumentsSize(args, 16); const index = args.readUInt32LE(4); if (index >= 8) return { value: 0 };
      if (flagRanges?.profile !== "CatSystem2-flag-ranges-2.6.1.76" || typeof flagRanges.range !== "function")
        throw new Error("KCS flag ranges require authored startup settings.");
      const pair = flagRanges.range(args.readUInt32LE(0), index), output = [pair.start, pair.count].map(value => {
        if (!Number.isInteger(value) || value < -1 || value > 65536) throw new Error("KCS flag range exceeds its limit.");
        const bytes = Buffer.alloc(4); bytes.writeInt32LE(value); return bytes;
      });
      machine.resolve(args.readUInt32LE(8), 4, { write: true }); machine.resolve(args.readUInt32LE(12), 4, { write: true });
      output.forEach((bytes, offset) => machine.writeBytes(args.readUInt32LE(8 + offset * 4), bytes)); return { value: 1 };
    }],
    [209, ({ arguments: args }) => {
      argumentsSize(args, 4); const count = args.readUInt32LE(0);
      if (!Number.isInteger(count) || count < 1 || count > 65536) throw new Error("KCS flag region exceeds its declared limit.");
      if (sharedState && count !== state.variables.length) throw new Error("KCS child flag region disagrees with the shared game state.");
      if (!state.variables) state.variables = new Int32Array(count); return {};
    }],
    [210, ({ arguments: args }) => {
      argumentsSize(args, 4); const index = args.readUInt32LE(0);
      // The native flag getter returns zero for absent storage or an index
      // outside its unsigned extent; it never extends the authored region.
      return { value: state.variables && index < state.variables.length ? state.variables[index] : 0 };
    }],
    [211, ({ arguments: args }) => {
      argumentsSize(args, 8); const index = args.readUInt32LE(0);
      if (!state.variables || index >= state.variables.length) throw new Error("KCS variable index exceeds its authored region."); state.variables[index] = args.readInt32LE(4); return {};
    }],
    [938, ({ arguments: args }) => { argumentsSize(args, 0); return { value: Number(state.soundConfig != null) }; }],
    [247, async ({ machine, arguments: args }) => {
      argumentsSize(args, 4); if (typeof readStoredData !== "function") throw new Error("KCS stored data requires a bounded save provider.");
      const bytes = await readStoredData(formatKernelString(machine, args.readUInt32LE(0)));
      if (bytes === null) return { value: 0 };
      if (!Buffer.isBuffer(bytes)) throw new Error("The KCS stored-data provider returned an invalid result.");
      return { value: await dataRecords.load(bytes) };
    }],
    [248, ({ arguments: args }) => {
      argumentsSize(args, 4); if (args.readUInt32LE(0)) throw new Error("The KCS stored-data handle is unsupported."); return {};
    }],
    [276, ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const id = args.readUInt32LE(0), bytes = machine.stringBytes(args.readUInt32LE(4));
      if (id >= 1024 || bytes.length > 4096) throw new Error("KCS string variables exceed their limit."); state.strings.set(id, Encoding.decode(bytes)); return {};
    }],
    [277, ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const id = args.readUInt32LE(0);
      if (id >= 1024) throw new Error("KCS string variables exceed their limit.");
      const found = state.strings.has(id), bytes = Encoding.encode(state.strings.get(id) ?? "");
      machine.writeBytes(args.readUInt32LE(4), Buffer.concat([bytes, Buffer.alloc(1)])); return { value: Number(found) };
    }],
    [238, ({ arguments: args }) => { argumentsSize(args, 4); return { value: dataRecords.create(args.readUInt32LE(0)) }; }],
    [246, ({ arguments: args }) => { argumentsSize(args, 4); const handle = args.readUInt32LE(0); if (handle) dataRecords.release(handle); return {}; }],
    [469, ({ arguments: args }) => { argumentsSize(args, 8); const handle = args.readUInt32LE(0); if (handle) dataRecords.remove(handle, args.readUInt32LE(4)); return {}; }],
    [240, ({ arguments: args }) => {
      argumentsSize(args, 20); const [handle, id, sourceTask, start, count] = [0, 4, 8, 12, 16].map(offset => args.readUInt32LE(offset));
      if (!handle) return { value: 0 }; dataRecords.lookup(handle);
      if (sourceTask !== taskId || !state.variables || start > state.variables.length - count) throw new Error("KCS saved flags require the original task's bounded variable region.");
      const bytes = Buffer.alloc(count * 4); for (let index = 0; index < count; index++) bytes.writeInt32LE(state.variables[start + index], index * 4);
      dataRecords.put(handle, id, bytes); return { value: 1 };
    }],
    [244, ({ machine, arguments: args }) => {
      argumentsSize(args, 16); const handle = args.readUInt32LE(0); if (!handle) return { value: 0 };
      const length = args.readUInt32LE(8); dataRecords.lookup(handle);
      if (length > 16 * 1024 * 1024) throw new Error("KCS stored bytes exceed their limit.");
      const range = machine.resolve(args.readUInt32LE(12), length);
      dataRecords.put(handle, args.readUInt32LE(4), range.bytes.subarray(range.offset, range.offset + length)); return { value: 1 };
    }],
    [245, async ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const handle = args.readUInt32LE(0); if (!handle) return { value: 0 };
      if (typeof writeStoredData !== "function") throw new Error("KCS stored data requires a bounded save writer.");
      const filename = formatKernelString(machine, args.readUInt32LE(4)), bytes = await encodeStoredData(dataRecords.lookup(handle));
      const written = await writeStoredData(filename, bytes);
      if (typeof written !== "boolean") throw new Error("The KCS stored-data writer returned an invalid result."); return { value: Number(written) };
    }],
    [359, ({ machine, arguments: args }) => {
      argumentsSize(args, 16);
      if (preferenceRecords?.profile !== "cs2-2.6.1.76-preferences" || preferenceRecords.records?.length !== 4) throw new Error("This KCS host preference layout is unsupported.");
      const targets = [];
      for (let index = 0; index < 4; index++) {
        const address = args.readUInt32LE(index * 4);
        const record = preferenceRecords.records[index];
        if (!(address & 0x80000000) || !Buffer.isBuffer(record?.bytes) || !Buffer.isBuffer(record?.known) || record.bytes.length !== [5628, 72, 32, 12][index] ||
            record.known.length !== record.bytes.length || !record.known.every(value => value === 0 || value === 1))
          throw new Error("KCS preferences require a bounded external output region.");
        const target = machine.resolve(address, record.bytes.length, { write: true });
        if (target.bytes !== flags) throw new Error("KCS preferences require the host's external output region."); targets.push(target);
      }
      for (let index = 0; index < 4; index++) {
        const record = preferenceRecords.records[index], target = targets[index];
        record.bytes.copy(target.bytes, target.offset); record.known.copy(known, target.offset);
      }
      return {};
    }],
    // Two logical output pointers receive the actual authored viewport size.
    [8, ({ machine, arguments: args }) => {
      argumentsSize(args, 8);
      if (!state.canvas || ![state.canvas.width, state.canvas.height].every(value => Number.isInteger(value) && value >= 1 && value <= 16384) || state.canvas.width * state.canvas.height > 32 * 1024 * 1024)
        throw new Error("KCS viewport dimensions require validated authored startup settings.");
      for (let index = 0; index < 2; index++) {
        const bytes = Buffer.alloc(4); bytes.writeUInt32LE(index ? state.canvas.height : state.canvas.width); machine.writeBytes(args.readUInt32LE(index * 4), bytes);
      }
      return {};
    }],
    // Original string-copy service writes a two-byte NUL terminator and returns
    // the destination logical pointer. Copy bytes before resolving overlapping
    // destinations, and enforce the VM's complete destination range.
    [13, ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const destination = args.readUInt32LE(0), source = Buffer.from(machine.stringBytes(args.readUInt32LE(4)));
      machine.writeBytes(destination, Buffer.concat([source, Buffer.alloc(2)])); return { value: destination };
    }],
    [14, ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const destination = args.readUInt32LE(0), source = formatKernelBytes(machine, args.readUInt32LE(4));
      machine.writeBytes(destination, Buffer.concat([source, Buffer.alloc(2)])); return { value: destination };
    }],
    ...[[15, false], [16, true]].map(([id, formatted]) => [id, ({ machine, arguments: args }) => {
      argumentsSize(args, 8); const destination = args.readUInt32LE(0), current = Buffer.from(machine.stringBytes(destination));
      const source = Buffer.from(formatted ? formatKernelBytes(machine, args.readUInt32LE(4)) : machine.stringBytes(args.readUInt32LE(4)));
      if (current.length + source.length > 1024 * 1024) throw new Error("KCS concatenated string exceeds its limit.");
      machine.writeBytes(destination, Buffer.concat([current, source, Buffer.alloc(2)])); return { value: destination };
    }]),
    [590, async ({ machine, arguments: args }) => {
      argumentsSize(args, 4);
      if (typeof readAsset !== "function" || documents.size >= 256 || nextDocument > 0x7fffffff) throw new Error("KCS XML resources require a bounded original asset provider.");
      const bytes = await readAsset(formatKernelString(machine, args.readUInt32LE(0)), { maximumBytes: XML.LIMITS.bytes }), document = XML.parseXml(bytes), id = nextDocument++;
      documents.set(id, document); return { value: id };
    }],
    [591, ({ arguments: args }) => {
      argumentsSize(args, 4); const id = args.readUInt32LE(0);
      if (id && !documents.delete(id)) throw new Error("KCS XML document handle is invalid."); return {};
    }],
    [592, ({ machine, arguments: args }) => {
      const value = documentScalar(machine, args); if (value == null) return { value: args.readUInt32LE(4) };
      if (!/^[+-]?(?:\d+|0x[0-9a-f]+)$/i.test(value)) throw new Error("KCS XML integer value is unsupported.");
      const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < -0x80000000 || parsed > 0xffffffff) throw new Error("KCS XML integer value exceeds its range.");
      return { value: parsed >>> 0 };
    }],
    [593, ({ machine, arguments: args }) => {
      const value = documentScalar(machine, args); if (value == null) return {};
      const bytes = Encoding.encode(value); machine.writeBytes(args.readUInt32LE(4), Buffer.concat([bytes, Buffer.alloc(1)])); return {};
    }],
    [594, async ({ machine, arguments: args }) => {
      argumentsSize(args, 4);
      if (typeof assetExists !== "function") throw new Error("KCS optional name tables require a bounded original asset provider.");
      const present = await assetExists(formatKernelString(machine, args.readUInt32LE(0)));
      if (typeof present !== "boolean") throw new Error("The KCS asset provider returned an invalid existence result.");
      if (!present) return { value: 0 };
      throw new Error("This KCS name-table format is unsupported.");
    }],
    [595, ({ arguments: args }) => {
      argumentsSize(args, 4); if (args.readUInt32LE(0)) throw new Error("This KCS name-table handle is unsupported."); return {};
    }],
    ...[596, 597].map(id => [id, ({ arguments: args }) => {
      argumentsSize(args, 20); if (args.readUInt32LE(0)) throw new Error("This KCS name-table handle is unsupported."); return { value: 0 };
    }]),
    [400, async ({ machine, arguments: args }) => {
      argumentsSize(args, 8); if (typeof readAsset !== "function") throw new Error("KCS sound loop points require an original asset provider.");
      const source = await readAsset(formatKernelString(machine, args.readUInt32LE(4)), { maximumBytes: 1024 * 1024 });
      const lines = Encoding.decode(source).split(/\r?\n/); if (lines.length > 10000) throw new Error("KCS sound loop table exceeds its row limit.");
      const points = new Map();
      for (const line of lines) {
        const words = tokens(line); if (!words.length) continue;
        if (words.length < 1 || words.length > 3 || !/^"[^"\\/]+"$/.test(words[0])) throw new Error("Unsupported KCS sound loop-point row.");
        const name = words[0].slice(1, -1); if (points.has(name)) throw new Error("KCS sound loop-point name is repeated.");
        const sample = text => { if (text == null) return -1; if (!/^-?\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < -1) throw new Error("KCS sound loop-point sample is invalid."); return Number(text); };
        const start = sample(words[1]), end = sample(words[2]); if (start >= 0 && end >= 0 && end < start) throw new Error("KCS sound loop-point range is reversed.");
        points.set(name, { start, end });
      }
      state.loopPoints = points; return {};
    }]
  ]);
  // The two dictionary families share allocation, lookup, clear and disposal
  // handlers in this version. The float setter only transfers its DWORD with
  // MOVSS; retaining the bits avoids conversion or loss of NaN payloads.
  for (const [id, source] of [[885, 894], [886, 895], [887, 896], [888, 897], [889, 898]]) {
    nativeCalls.set(id, input => {
      const version = engineVersion ?? (startupOptions?.profile === "CatSystem2-startup-options-2.6.1.76" ? "2.6.1.76" : null);
      if (version !== "2.6.1.76") throw new Error("This KCS float dictionary version is unsupported.");
      return nativeCalls.get(source)(input);
    });
  }
  const externalMemory = (offset, length) => offset >= 0 && length >= 0 && offset <= flags.length - length ? {
    bytes: flags, offset, readable: (start, size) => known.subarray(start, start + size).every(value => value === 1), didWrite: (start, size) => known.fill(1, start, start + size)
  } : null;
  return { state, flags, memory: { bytes: flags, known }, nativeCalls, externalMemory, documents, messages, dataRecords,
    get motionControllers() { return motionControllers; }, close() { motionControllers?.close(); } };
}
module.exports = { createKernelServices };
