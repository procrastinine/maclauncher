const { inspectFrontEndScript } = require("../frontend-script"), { parseFrontEnd } = require("../frontend-parser");
const { FrontEndMachine } = require("./frontend-vm"), { FrontEndObjects, priorityKey } = require("./frontend-objects");
const Encoding = require("../encoding");
const { OFFSET } = require("./motion-vm");
const { formatFrontEndString } = require("./frontend-format");
const { runtimeSource } = require("./frontend-source");
const LIMITS = Object.freeze({ scripts: 128, depth: 32, frames: 1000000 });

/** Authored FES hierarchy with shared flags, isolated objects and explicit services. */
function createFrontEndHost({ engineVersion, tasks, registry, kernelState, canvas, language, assets, soundConfig, config, steam, saveSlots,
  loadFrame, describeFrame, loadMotion, loadAnimation, colorFrame, composePlane, sound, text, cursor, cgRegistry, kernelTasks, present, trace, signal } = {}) {
  if (!tasks?.lookup || !registry?.read || !kernelState || !assets?.exists) throw new Error("Bounded CatSystem2 front-end services are required.");
  const scripts = new Map(); let lastFrame = -1, inFrame = false, baseImage = [], lastInput = {}, inputScript = null, presentedScene = null, lastPointer = null;
  function record(id) { const item = scripts.get(id); if (!item) throw new Error("The CatSystem2 front-end script handle is absent."); return item; }
  function flag(machine, source, value) {
    const index = machine.value(source); if (index < 0 || index >= machine.globals.length || !Number.isInteger(value)) throw new Error("FES host output exceeds its authored flag region.");
    machine.globals[index] = value;
  }
  function selectors(machine, name, supplied) { return name.endsWith("_id") ? supplied.map(value => machine.value(value)) : supplied.map(value => machine.string(value)); }
  function clearBackgroundButton(item) {
    if (engineVersion !== "2.6.1.76") throw new Error("This FES background-button profile is unsupported.");
    if (item.backgroundButton == null) return;
    const button = tasks.lookup(item.backgroundButton, "button");
    if (button.parent !== item.id) throw new Error("The FES background button belongs to another screen.");
    tasks.remove(button.id); item.backgroundButton = null;
  }
  async function dispose(id) {
    const item = record(id); if (item.child != null) await dispose(item.child);
    if (item.kernel != null) { if (!kernelTasks?.remove) throw new Error("FES child kernel shutdown is unavailable."); await kernelTasks.remove(item.kernel); item.kernel = null; }
    await sound?.dispose?.(item.objects, item.machine); item.machine.stop(); scripts.delete(id);
  }
  async function load(id, name, parent = null, { notifyParent = true } = {}) {
    signal?.throwIfAborted(); const task = tasks.lookup(id, "front-end");
    if (scripts.size >= LIMITS.scripts || typeof name !== "string" || !name || Encoding.encode(name).length > 255 ||
        !(kernelState.variables instanceof Int32Array) || !(kernelState.strings instanceof Map)) throw new Error("FES script allocation or shared state exceeds its limit.");
    const bytes = await registry.read("fes", name, { maximumBytes: 16 * 1024 * 1024 }), decoded = await inspectFrontEndScript(bytes);
    const program = parseFrontEnd(runtimeSource(decoded, { engineVersion })), item = { id, task, name, parent, child: null, kernel: null, backgroundButton: null, machine: null, objects: null, frame: -1, started: false };
    const objects = new FrontEndObjects(program, { engineVersion, canvas, language: () => config?.language ?? language, loadFrame, describeFrame, loadMotion, loadAnimation, colorFrame, composePlane, sound, text, signal }); item.objects = objects;
    const host = { resolveObject: objects.resolveObject.bind(objects), resolveTargets: objects.resolveTargets.bind(objects), isBusy: objects.isBusy.bind(objects),
      tick: (frame, machine, input) => objects.tick(frame, machine, inputScript === item.id ? input : {}), command: (command, args, machine) => execute(item, command, args, machine),
      exit: code => { item.task.exitCode = code; if (notifyParent && item.parent != null) record(item.parent).machine.childExitCode = code; } };
    item.machine = new FrontEndMachine(program, { globals: kernelState.variables, strings: kernelState.strings, host, signal,
      trace: event => trace?.({ taskId: id, name, ...event }) });
    await objects.prepare(item.machine);
    if (scripts.has(id)) await dispose(id); scripts.set(id, item); return item;
  }
  async function start(id) {
    signal?.throwIfAborted(); const item = record(id);
    if (item.started) throw new Error("This FES screen has already started.");
    item.started = true;
    // Message14D runs the screen's initial tick immediately. Loading alone
    // leaves it dormant, as in the original task factory.
    return item.machine.tick(++item.frame, lastInput);
  }
  function setLocal(id, index, value) {
    const item = record(id);
    if (!Number.isInteger(index) || index < 0 || index >= item.machine.locals.length || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
      throw new Error("KCS front-end local value exceeds its range.");
    item.machine.locals[index] = value;
  }
  function getLocal(id, index) {
    const item = record(id);
    if (!Number.isInteger(index) || index < 0 || index >= item.machine.locals.length)
      throw new Error("KCS front-end local index exceeds its range.");
    return item.machine.locals[index];
  }
  async function callBlock(id, label, objectName = "", index = 0) {
    signal?.throwIfAborted(); const item = record(id);
    if (engineVersion !== "2.6.1.76" || !item.started || typeof label !== "string" || !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(label) ||
        typeof objectName !== "string" || objectName && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(objectName) || !Number.isInteger(index) || index < 0 || index >= 4096)
      throw new Error("This external FES callback profile is unsupported.");
    const name = objectName ? `${objectName}.${label}` : label;
    if (name.length > 63) throw new Error("The FES callback label exceeds its range.");
    const object = objectName ? item.objects.resolveObject(objectName,index) || item.objects.resolveObject(objectName) : null;
    if (objectName && !object) throw new Error("The external FES callback object is absent.");
    const matched = await item.machine.invokeBlock(name,object);
    trace?.({ taskId:id,command:"external-call",label:name,matched }); return matched;
  }
  async function execute(item, name, args, machine) {
    const size = (minimum, maximum = minimum) => { if (args.length < minimum || args.length > maximum) throw new Error(`Unsupported FES ${name} arguments.`); };
    if (name === "deletebgbutton") { size(0); clearBackgroundButton(item); }
    else if (name === "force_redraw") {
      size(0); if (engineVersion !== "2.6.1.76") throw new Error("This FES redraw profile is unsupported.");
      presentedScene = null;
    }
    else if (name === "decode") {
      size(0,1); item.objects.configurePointerFocus(args.length ? machine.value(args[0]) : 0);
      return { yield: true };
    }
    else if (name === "wndmenu") {
      size(1); if (engineVersion !== "2.6.1.76" || machine.value(args[0]) !== 13) throw new Error("This FES window-menu action is unsupported.");
      if (typeof kernelTasks?.resetMessageWindow !== "function") throw new Error("KCS window-message delivery is unavailable.");
      kernelTasks.resetMessageWindow();
    }
    else if (name === "execfes") {
      size(1); if (item.child != null) throw new Error("FES child screens require endfes before replacement.");
      let depth = 0, ancestor = item; while (ancestor.parent != null) { if (++depth >= LIMITS.depth) throw new Error("FES child screens exceed their depth limit."); ancestor = record(ancestor.parent); }
      const child = tasks.create(34, item.id, machine.string(args[0]));
      try { const loaded = await load(child.id, machine.string(args[0]), item.id); loaded.started = true; item.child = child.id; machine.childExitCode = -1; } catch (error) { tasks.remove(child.id); throw error; }
    } else if (name === "endfes") {
      size(0); if (item.child != null) { await dispose(item.child); tasks.remove(item.child); item.child = null; } machine.childExitCode = -1;
    } else if (name === "execkcs") {
      size(1); if (!kernelTasks?.create) throw new Error("FES child kernel execution is unavailable.");
      if (item.kernel != null || item.child != null) throw new Error("FES child scripts require shutdown before replacement.");
      machine.childExitCode = -1;
      const child = await kernelTasks.create({ parentId: item.id, name: machine.string(args[0]), onExitCode: code => { machine.childExitCode = code; } });
      if (!Number.isInteger(child?.id) || child.id < 1 || child.id > 65535) throw new Error("The FES child kernel returned an invalid handle.");
      item.kernel = child.id;
    } else if (name === "endkcs") {
      size(0); if (item.kernel != null) {
        if (!kernelTasks?.remove) throw new Error("FES child kernel shutdown is unavailable.");
        await kernelTasks.remove(item.kernel); item.kernel = null;
      }
      machine.childExitCode = -1;
    } else if (name === "fileexist") { size(2); flag(machine, args[1], Number(await assets.exists(machine.string(args[0])))); }
    else if (name === "saveexist") {
      size(2, 4); if (!saveSlots?.exists) throw new Error("CatSystem2 save-slot access is unavailable.");
      const minimum = args.length >= 3 ? machine.value(args[2]) : -1, maximum = args.length === 4 ? machine.value(args[3]) : minimum;
      flag(machine, args[1], await saveSlots.exists(machine.value(args[0]), minimum, maximum));
    } else if (name === "savecopy" || name === "savedelete") {
      size(name === "savecopy" ? 2 : 1);
      const operation = saveSlots?.[name === "savecopy" ? "copy" : "remove"];
      if (typeof operation !== "function") throw new Error("CatSystem2 save-slot access is unavailable.");
      await operation(...args.map(value => machine.value(value)));
    }
    else if (name === "steam_isenable" || name === "steam_isbroadcast") {
      size(1); const value = steam?.[name === "steam_isenable" ? "enabled" : "broadcasting"];
      if (typeof value !== "boolean") throw new Error("FES Steam state is unavailable."); flag(machine, args[0], Number(value));
    } else if (name === "steam_achievement") {
      size(1); const achievement = machine.string(args[0]);
      if (engineVersion !== "2.6.1.76" || typeof steam?.enabled !== "boolean" || !/^[A-Za-z0-9_.-]{1,127}$/.test(achievement))
        throw new Error("This FES achievement command is unsupported.");
      // The native handler skips the call when its Steam adapter is absent.
      // An enabled adapter must provide the actual achievement operation.
      if (steam.enabled) {
        if (typeof steam.setAchievement !== "function") throw new Error("FES achievements are unavailable.");
        if (typeof await steam.setAchievement(achievement) !== "boolean") throw new Error("The FES achievement result is invalid.");
      }
    } else if (name === "setconf") {
      size(2, 4); if (typeof config?.set !== "function") throw new Error("FES preferences are unavailable.");
      await config.set(machine.string(args[1]), machine.value(args[0]), args.slice(2).map(source => machine.value(source)));
    } else if (name === "getconf") {
      size(2, 4); if (typeof config?.get !== "function") throw new Error("FES preferences are unavailable.");
      flag(machine, args[0], await config.get(machine.string(args[1]), args.slice(2).map(source => machine.value(source))));
    } else if (name === "getsndconfex" || name === "setsndconfex") {
      size(3, 18); if (!soundConfig?.query || !soundConfig?.set) throw new Error("FES sound preferences are unavailable.");
      const setting = machine.string(args[1]), selected = selectors(machine, setting, args.slice(2));
      if (name === "getsndconfex") flag(machine, args[0], soundConfig.query(setting, selected)); else soundConfig.set(setting, machine.value(args[0]), selected);
    } else if (name === "xchgcursor") {
      size(0, 3); if (!cursor?.select || args.length === 2) throw new Error("This FES cursor command is unsupported.");
      await cursor.select(args.length ? machine.string(args[0]) : "default", args.length === 3 ? args.slice(1).map(value => machine.value(value)) : undefined);
    } else if (name === "strvar") {
      size(2, 6); const index = machine.value(args[0]), value = formatFrontEndString(machine.string(args[1]), args.slice(2), machine);
      if (index < 0 || index >= 1024 || Encoding.encode(value).length > 4096) throw new Error("FES string variables exceed their limit."); machine.strings.set(index, value);
    } else if (name === "cgreg_init") {
      size(3); if (!cgRegistry?.initialize) throw new Error("FES CG registration is unavailable.");
      await cgRegistry.initialize(machine.string(args[0]), machine.value(args[1]), machine.string(args[2]));
    } else if (name === "cgreg_t") {
      size(2); if (!cgRegistry?.registered) throw new Error("FES CG registration is unavailable.");
      const source = machine.string(args[1]), numeric = /^(?:[\\$]|[+-]?\d|0x|\()/.test(source);
      flag(machine, args[0], cgRegistry.registered(numeric ? machine.value(args[1]) : source));
    } else if (name === "baseimg") {
      size(0, 1); if (!args.length) baseImage = [];
      else {
        const object = item.objects.resolveObject(args[0]); if (!object || !["IMAGE", "CIMAGE", "PLANE"].includes(object.type)) throw new Error("FES base image requires an authored image or plane.");
        const layers = await item.objects.layers(); baseImage = layers.filter(layer => object.type === "PLANE" ? item.objects.objects.get(layer.id)?.plane === object : layer.id === object.id)
          .map(layer => ({ ...layer, id: "base:" + layer.id, opacity: 1, visible: true }));
        if (!baseImage.length) throw new Error("FES base image has no decoded authored layers.");
      }
    } else if (name === "dbgstr" || name === "debug") { size(1); trace?.({ taskId: item.id, command: name, ...(name === "debug" ? { value: machine.value(args[0]) } : {}) }); }
    else return item.objects.command(name, args, machine);
    return true;
  }
  async function layers() {
    const output = [];
    for (const task of tasks.tasks.values()) if (task.kind === "plane" && task.visible && task.surfaceBitmap && !task.surfacePixelsKnown)
      throw new Error("This KCS plane surface is not initialized for display.");
    for (const task of tasks.tasks.values()) if (task.kind === "plane" && task.visible && task.fillEnabled) {
      if (!task.width || !task.height) continue;
      if ([0, 4, 8].some(offset => task.bytes.readFloatLE(OFFSET.scale + offset) !== 1)) throw new Error("This KCS plane scale cannot be displayed.");
      if (task.matrixMode != null && [...Array(16)].some((_, index) => task.bytes.readFloatLE(0x24 + index * 4) !== (index % 5 === 0 ? 1 : 0)))
        throw new Error("This KCS plane matrix cannot be displayed.");
      if (!colorFrame) throw new Error("KCS plane rendering is unavailable.");
      const frame = await colorFrame(task.width, task.height, task.fillColor),
        x = task.bytes.readFloatLE(OFFSET.position) - task.bytes.readFloatLE(OFFSET.base),
        y = task.bytes.readFloatLE(OFFSET.position + 4) - task.bytes.readFloatLE(OFFSET.base + 4), priority = task.bytes.readFloatLE(OFFSET.base + 8);
      if (![x, y, priority].every(Number.isFinite)) throw new Error("KCS plane render geometry is invalid.");
      output.push({ id: `kcs:${task.id}`, rgbaPath: frame.rgbaPath, width: frame.width, height: frame.height, x, y,
        opacity: task.bytes[OFFSET.alpha] / 255, visible: true, priority: [priority, 0, task.id], taskId: task.id });
    }
    for (const item of scripts.values()) for (const layer of await item.objects.layers()) {
      const object = item.objects.objects.get(layer.id); output.push({ ...layer, id: `${item.id}:${layer.id}`, priority: priorityKey(object), taskId: item.id });
    }
    output.sort((a, b) => a.priority[0] - b.priority[0] || a.priority[1] - b.priority[1] || a.taskId - b.taskId || a.priority[2] - b.priority[2]);
    const visible = output.some(layer => layer.visible && layer.opacity > 0);
    return (visible ? output : baseImage).map(({ priority, taskId, ...layer }, index) => ({ ...layer, z: index }));
  }
  async function tick(frame, input = {}) {
    signal?.throwIfAborted();
    if (inFrame || !Number.isSafeInteger(frame) || frame !== lastFrame + 1 || frame > LIMITS.frames) throw new Error("FES host frame sequence is invalid.");
    if (input.pointer != null) {
      if (![input.pointer.x, input.pointer.y].every(value => Number.isInteger(value) && Math.abs(value) <= 1048576)) throw new Error("FES pointer coordinates exceed their range.");
      lastPointer = { x: input.pointer.x, y: input.pointer.y };
    }
    inFrame = true; lastFrame = frame; lastInput = input;
    try {
      if (kernelTasks?.tick) await kernelTasks.tick(frame);
      const ordered = [...scripts.values()]; const depth = item => { let value = 0; while (item.parent != null) { item = record(item.parent); value++; } return value; };
      ordered.sort((a, b) => depth(b) - depth(a) || a.id - b.id);
      inputScript = ordered.find(item => item.started && !item.machine.ended)?.id ?? null;
      for (const item of ordered) if (scripts.get(item.id) === item && item.started) await item.machine.tick(++item.frame, input);
      const scene = { canvas, layers: await layers() }, signature = JSON.stringify(scene);
      if (signature !== presentedScene) { await present?.(scene); presentedScene = signature; }
      return scene;
    } finally { inputScript = null; inFrame = false; }
  }
  return { scripts, load, start, dispose, record, setLocal, getLocal, callBlock, tick, layers, getPointer: () => lastPointer && { ...lastPointer } };
}
module.exports = { LIMITS, createFrontEndHost };
