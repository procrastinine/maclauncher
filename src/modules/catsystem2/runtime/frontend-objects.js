const { expression } = require("../frontend-expression");
const { MotionMachine, OFFSET, LIMITS: MOTION } = require("./motion-vm");
const { imageGeometry } = require("./frontend-geometry");
const { ImageAnimation } = require("./image-animation");
const Encoding = require("../encoding");
const { memberPath } = require("../startup");

const LIMITS = Object.freeze({ objects: 4096, motions: 256, dimension: 16384 });
const TEXT = new Set(["STRING", "STRING8"]), EXTERNAL = new Set(["DIFIMAGE", "SAVEPANEL"]);
const DRAWABLE = new Set(["IMAGE", "CIMAGE", "BUTTON", "CPLANE", ...TEXT, ...EXTERNAL]), AUDIO = new Set(["SOUND", "SNDTABLE"]), TYPES = new Set([...DRAWABLE, "PLANE", ...AUDIO]);
const scalar = (source, context = {}) => expression(source, context);
function tuple(source, size, context = {}) {
  const values = source.split(","); if (values.length !== size) throw new Error("Unsupported FES object tuple."); return values.map(value => scalar(value, context));
}
function objectBytes() {
  const bytes = Buffer.alloc(MOTION.objectBytes); for (let at = OFFSET.scale; at < OFFSET.scale + 12; at += 4) bytes.writeFloatLE(1, at);
  bytes.writeUInt32LE(0xffffffff, OFFSET.color); return bytes;
}
const floats = (bytes, offset) => Array.from({ length: 3 }, (_, index) => bytes.readFloatLE(offset + index * 4));
function priorityKey(object) {
  const own = object.bytes.readFloatLE(OFFSET.base + 8), plane = object.plane?.bytes.readFloatLE(OFFSET.base + 8);
  if (!Number.isFinite(own) || plane != null && !Number.isFinite(plane)) throw new Error("FES render priority is invalid.");
  return plane == null ? [own, 0, object.handle] : [plane, own, object.handle];
}
function compareObjects(left, right) { const a = priorityKey(left), b = priorityKey(right); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

class FrontEndObjects {
  constructor(program, { engineVersion, canvas, language, loadFrame, describeFrame = loadFrame, loadMotion, loadAnimation, colorFrame, composePlane, sound, text, signal } = {}) {
    if (!(program?.objects instanceof Map) || program.objects.size > LIMITS.objects || !canvas || ![canvas.width, canvas.height].every(value => Number.isInteger(value) && value > 0 && value <= LIMITS.dimension))
      throw new Error("Bounded FES object definitions and canvas are required.");
    this.program = program; this.engineVersion = engineVersion; this.canvas = canvas; this.language = language; this.loadFrame = loadFrame; this.describeFrame = describeFrame; this.loadMotion = loadMotion;
    this.colorFrame = colorFrame; this.composePlane = composePlane; this.loadAnimation = loadAnimation; this.sound = sound; this.text = text; this.signal = signal; this.objects = new Map(); this.groups = new Map(); this.motionPrograms = new Map(); this.defaultButton = null;
    this.focus = null; this.keyboardFocus = null; this.retainPointerFocus = false; this.pressedButtons = new Map();
    let handle = 1;
    for (const source of program.objects.values()) {
      if (!TYPES.has(source.type)) throw new Error(`FES object type ${source.type} is unsupported.`);
      if ((TEXT.has(source.type) || EXTERNAL.has(source.type)) && engineVersion !== "2.6.1.76") throw new Error(`This FES ${source.type} profile is unsupported.`);
      const object = { ...source, handle: handle++, attributes: new Map(source.attributes), bytes: objectBytes(), motions: [], idTable: new Map([[0, 0]]), tableMode: false, selected: 0,
        visible: false, enabled: true, buttonType: 0, file: null, plane: null, parent: null, width: 0, height: 0, frame: null, defaultHandler: null,
        textContent: TEXT.has(source.type) ? "" : null, externalFrame: null, mask: 0, animationName: null, animationEnabled: false, animation: null, animationFrameId: null };
      this.initialize(object);
      if (object.tableMode && object.selected < 0) throw new Error("FES negative image IDs with an active table are unsupported.");
      this.objects.set(object.id, object);
      if (!this.groups.has(object.group)) this.groups.set(object.group, []); this.groups.get(object.group).push(object);
    }
    for (const object of this.objects.values()) for (const field of ["plane", "parent"]) {
      if (!object[field]) continue;
      const target = this.objects.get(object[field]); if (!target || field === "plane" && !["PLANE", "CPLANE"].includes(target.type)) throw new Error("FES object parent or plane is absent or incompatible.");
      object[field] = target;
    }
    for (const object of this.objects.values()) { const seen = new Set([object]); let parent = object.parent; while (parent) { if (seen.has(parent)) throw new Error("FES object parent cycle is unsupported."); seen.add(parent); parent = parent.parent; } }
    for (const object of this.objects.values()) if (object.mask && (object.plane?.type !== "PLANE" || object.bytes[OFFSET.alpha] !== 255))
      throw new Error("FES alpha masks require an opaque mask and a drawing plane.");
  }
  initialize(object) {
    const put = (offset, source) => tuple(source, 2).forEach((value, index) => object.bytes.writeFloatLE(value, offset + index * 4));
    for (const [name, source] of object.attributes) {
      if (name === "FILE") {
        if (TEXT.has(object.type) || object.type === "DIFIMAGE") throw new Error("This FES object does not load a FILE image."); object.file = source;
      }
      else if (["SIZE2", "POS2"].includes(name)) {
        if (this.engineVersion !== "2.6.1.76" || AUDIO.has(object.type) || !source) throw new Error(`This FES ${name} profile is unsupported.`);
      }
      else if (name === "PL") object.plane = source;
      else if (name === "PARENT") object.parent = source;
      else if (name === "BASE") put(OFFSET.base, source);
      else if (name === "POS") put(OFFSET.position, source);
      else if (name === "VRAM") put(OFFSET.vram, source);
      else if (name === "PRI") object.bytes.writeFloatLE(scalar(source), OFFSET.base + 8);
      else if (name === "DISP") object.visible = Boolean(scalar(source));
      else if (name === "ENABLE") object.enabled = Boolean(scalar(source));
      else if (name === "BLEND") { const alpha = scalar(source); if (alpha < 0 || alpha > 255) throw new Error("FES opacity exceeds its range."); object.bytes[OFFSET.alpha] = alpha; }
      else if (name === "COLOR") object.bytes.writeUInt32LE(scalar(source) >>> 0, OFFSET.color);
      else if (name === "MASK" && object.type === "IMAGE") {
        object.mask = scalar(source);
        if (this.engineVersion !== "2.6.1.76" || ![0, 4].includes(object.mask)) throw new Error("This FES image mask profile is unsupported.");
      }
      else if (name === "SIZE" && object.type === "SNDTABLE") {
        object.tableSize = scalar(source); if (!Number.isInteger(object.tableSize) || object.tableSize < 1 || object.tableSize > 4096) throw new Error("FES sound table exceeds its entry limit.");
      } else if (name === "SIZE") {
        [object.width, object.height] = tuple(source, 2); if (![object.width, object.height].every(value => value > 0 && value <= LIMITS.dimension) || object.width * object.height > 32 * 1024 * 1024) throw new Error("FES object size exceeds its pixel limit.");
      } else if (/^ID\.(\d+)$/.test(name)) {
        const index = Number(name.slice(3)), id = scalar(source); if (index > 15 || id < 0) throw new Error("FES image table ID exceeds its range."); object.idTable.set(index, id); object.tableMode = true;
      } else if (name === "IDN" && ["IMAGE", "BUTTON"].includes(object.type)) {
        if (this.engineVersion !== "2.6.1.76") throw new Error("This FES direct-image ID profile is unsupported.");
        object.selected = scalar(source); if (object.selected < -1) throw new Error("FES direct-image ID exceeds its range.");
      } else if (name === "DEFAULT") {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) throw new Error("Invalid FES default event handler."); object.defaultHandler = source;
      } else if (name === "TYPE" && object.type === "BUTTON") { object.buttonType = scalar(source); if (![0, 1].includes(object.buttonType)) throw new Error("Unsupported FES button hit type."); }
      else if (name === "TYPE" && object.type === "SNDTABLE") { object.volumeType = scalar(source); if (object.volumeType !== 0) throw new Error("This FES sound table volume mode is unsupported."); }
      else if (name === "KEYBLOCK" && object.type === "BUTTON") object.keyBlock = tuple(source, 3);
      else if (name === "GROUP" && AUDIO.has(object.type)) object.soundGroup = source;
      else if (["STYPE", "CHANNEL"].includes(name) && AUDIO.has(object.type)) {
        const value = scalar(source); if (value < 0 || value > (name === "STYPE" ? 2 : 31)) throw new Error("Unsupported FES sound type or channel."); object[name === "STYPE" ? "soundType" : "channel"] = value;
      } else throw new Error(`FES object attribute ${name} is unsupported.`);
    }
  }
  resolveObject(name, index = null, current = null) {
    if (name === "@") return current;
    if (index != null) return this.objects.get(`${name}[${index}]`);
    return this.objects.get(name) || (this.groups.get(name)?.length === 1 ? this.groups.get(name)[0] : null);
  }
  async prepare(machine) {
    this.machine = machine;
    // The original stores these references until the render task initializes.
    // SIZE2 takes cropped image dimensions, independently of its canvas; POS2
    // takes that frame's stored offset. Shared string variables retain their role.
    for (const object of this.objects.values()) {
      if (object.attributes.has("SIZE2")) {
        const geometry = await imageGeometry(object.attributes.get("SIZE2"), { engineVersion: this.engineVersion, machine, describeFrame: this.describeFrame });
        object.width = geometry.width; object.height = geometry.height; object.emptyReferencedSize = !geometry.available;
      }
      if (object.attributes.has("POS2")) {
        const geometry = await imageGeometry(object.attributes.get("POS2"), { engineVersion: this.engineVersion, machine, describeFrame: this.describeFrame });
        object.bytes.writeFloatLE(geometry.x, OFFSET.position); object.bytes.writeFloatLE(geometry.y, OFFSET.position + 4);
      }
    }
  }
  resolveTargets(source, current) {
    if (source === "@") return current ? [current] : null;
    if (this.objects.has(source)) return [this.objects.get(source)]; if (this.groups.has(source)) return this.groups.get(source);
    const indexed = /^([A-Za-z_][A-Za-z0-9_]*)\[(.*)\]$/.exec(source);
    if (indexed && this.machine) { const object = this.resolveObject(indexed[1], this.machine.value(indexed[2]), current); return object ? [object] : null; }
    return null;
  }
  get motionCount() { let count = 0; for (const object of this.objects.values()) count += object.motions.length; return count; }
  async isBusy(targets) {
    const explicit = targets != null;
    return (targets || [...this.objects.values()]).some(object => object.motions.some(motion => !motion.machine.done && motion.mode === "oneshot") ||
      explicit && AUDIO.has(object.type) && this.sound?.isBusy(object));
  }
  async frameFor(object) {
    if (TEXT.has(object.type)) {
      if (this.text?.frame) return this.text.frame(object, this.machine);
      if (object.textContent === "") return null;
      throw new Error("FES authored text rendering is unavailable.");
    }
    if (object.type === "DIFIMAGE") return object.externalFrame;
    if (object.type === "SAVEPANEL") throw new Error("FES save-panel rendering is unsupported.");
    if (["CIMAGE", "CPLANE"].includes(object.type)) {
      if (!this.colorFrame || !object.width || !object.height) throw new Error("FES color-image rendering is unavailable.");
      const color = object.bytes.readUInt32LE(OFFSET.color) & 0xffffff; if (!object.frame || object.frameColor !== color) { object.frame = await this.colorFrame(object.width, object.height, (color | 0xff000000) >>> 0); object.frameColor = color; }
      return object.frame;
    }
    if (!object.file || typeof this.loadFrame !== "function") throw new Error("FES image data is unavailable.");
    const id = object.animationFrameId ?? (object.tableMode ? object.idTable.get(object.selected) : object.selected);
    if (id === -1) return null;
    if (id == null) throw new Error("FES image table entry is absent.");
    const language = typeof this.language === "function" ? this.language() : this.language;
    const authored = this.machine ? this.machine.string(object.file) : object.file, expanded = authored.replaceAll("%LANG%", language || "%LANG%");
    if (!object.frame || object.frameId !== id || object.frameFile !== expanded) {
      object.frame = await this.loadFrame(expanded, id); object.frameId = id; object.frameFile = expanded;
    }
    return object.frame;
  }
  displayed(object) {
    let current = object; const visited = new Set();
    while (current) {
      if (visited.has(current)) throw new Error("FES render parent cycle is unsupported."); visited.add(current);
      if (!current.visible || !current.bytes[OFFSET.alpha] || current.type === "PLANE" && current.emptyReferencedSize) return false;
      current = current.parent || (current === object ? current.plane : null);
    }
    return true;
  }
  geometry(object, frame) {
    if (object.parent && object.plane && object.parent !== object.plane) throw new Error("FES separate parent and render-plane transforms are unsupported.");
    const lineage = [], seen = new Set(); let current = object;
    while (current) { if (seen.has(current)) throw new Error("FES render parent cycle is unsupported."); seen.add(current); lineage.push(current); current = current.parent || (current !== object ? null : current.plane); }
    let x = frame.offsetX || 0, y = frame.offsetY || 0, opacity = 1, visible = true;
    for (const item of lineage) {
      const position = floats(item.bytes, OFFSET.position), scale = floats(item.bytes, OFFSET.scale);
      if ([...position, ...scale].some(value => !Number.isFinite(value)) || scale.some(value => value !== 1) || item.bytes.subarray(0x24, 0x64).some(Boolean) || item.bytes.subarray(0x74, 0x90).some(Boolean))
        throw new Error("FES object transform requires unsupported rendering operations.");
      x += position[0]; y += position[1]; opacity *= item.bytes[OFFSET.alpha] / 255; visible &&= item.visible;
    }
    if (!["CIMAGE", "CPLANE"].includes(object.type) && (object.bytes.readUInt32LE(OFFSET.color) & 0xffffff) !== 0xffffff) throw new Error("FES image color modulation is unsupported.");
    return { x, y, opacity, visible };
  }
  async layers() {
    for (const object of this.objects.values()) if (object.mask && object.bytes[OFFSET.alpha] !== 255) throw new Error("FES mask opacity changes are unsupported.");
    const candidates = [...this.objects.values()].filter(object => DRAWABLE.has(object.type) && this.displayed(object));
    candidates.sort(compareObjects);
    const layers = [], maskedPlanes = new Set(candidates.filter(object => object.mask).map(object => object.plane)), composed = new Set();
    for (const object of candidates) {
      if (maskedPlanes.has(object.plane)) {
        const plane = object.plane;
        if (composed.has(plane)) continue; composed.add(plane);
        if (typeof this.composePlane !== "function" || !plane.width || !plane.height) throw new Error("FES alpha-mask plane compositing is unavailable.");
        const pieces = [];
        for (const child of candidates.filter(candidate => candidate.plane === plane)) {
          if (child.parent && child.parent !== plane) throw new Error("FES alpha-mask planes with separate image parents are unsupported.");
          const frame = await this.frameFor(child); if (!frame) continue;
          const position = floats(child.bytes, OFFSET.position), scale = floats(child.bytes, OFFSET.scale);
          if (scale.some(value => value !== 1) || position.some(value => !Number.isFinite(value)) || child.bytes.subarray(0x24, 0x64).some(Boolean) ||
              child.bytes.subarray(0x74, 0x90).some(Boolean) || (child.bytes.readUInt32LE(OFFSET.color) & 0xffffff) !== 0xffffff)
            throw new Error("FES alpha-mask image transforms are unsupported.");
          pieces.push({ width: frame.width, height: frame.height, rgba: frame.rgba, x: position[0] + (frame.offsetX || 0), y: position[1] + (frame.offsetY || 0),
            alpha: child.bytes[OFFSET.alpha], mask: child.mask });
        }
        const frame = await this.composePlane({ engineVersion: this.engineVersion, width: plane.width, height: plane.height, layers: pieces });
        layers.push({ id: plane.id, rgbaPath: frame.rgbaPath, width: frame.width, height: frame.height, frameId: frame.frameId, z: layers.length, ...this.geometry(plane, frame) });
        continue;
      }
      const frame = await this.frameFor(object); if (!frame) continue;
      const geometry = this.geometry(object, frame);
      layers.push({ id: object.id, rgbaPath: frame.rgbaPath, width: frame.width, height: frame.height, frameId: frame.frameId, z: layers.length, ...geometry });
    }
    return layers;
  }
  async hitTest(x, y) {
    const objects = [...this.objects.values()].filter(object => object.type === "BUTTON" && object.enabled && this.displayed(object)).sort(compareObjects).reverse();
    for (const object of objects) {
      const frame = await this.frameFor(object); if (!frame) continue;
      const geometry = this.geometry(object, frame);
      const localX = Math.floor(x - geometry.x), localY = Math.floor(y - geometry.y);
      if (!geometry.visible || !geometry.opacity || localX < 0 || localY < 0 || localX >= frame.width || localY >= frame.height) continue;
      if (object.buttonType || Buffer.isBuffer(frame.rgba) && frame.rgba[(localY * frame.width + localX) * 4 + 3]) return object;
      if (!Buffer.isBuffer(frame.rgba)) throw new Error("FES pixel hit testing requires decoded image alpha.");
    }
    return null;
  }
  async focusButton(object, machine) {
    if (object || !this.retainPointerFocus) this.keyboardFocus = object;
    if (object === this.focus) return;
    if (this.focus) machine.queueEvent(this.focus, "UNFOCUS"); this.focus = object;
    if (object) machine.queueEvent(object, "FOCUS");
  }
  configurePointerFocus(mode) {
    if (this.engineVersion !== "2.6.1.76" || ![0,1].includes(mode)) throw new Error("This FES pointer-focus mode is unsupported.");
    this.retainPointerFocus = Boolean(mode);
  }
  async processInput(input, machine) {
    if (input?.pointer) {
      const { x, y } = input.pointer;
      if (![x, y].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1048576)) throw new Error("Invalid authored FES pointer position.");
      machine.mouse.x = x; machine.mouse.y = y; await this.focusButton(await this.hitTest(x, y), machine);
    }
    const actions = input?.actions || [];
    if (!Array.isArray(actions) || actions.length > 256) throw new Error("FES input exceeds its frame limit.");
    for (const action of actions) {
      if (action.type === "navigate") throw new Error("FES keyboard navigation requires authored key blocks.");
      if (action.type !== "button" || ![0, 1, 2].includes(action.button) || !["down", "up"].includes(action.kind) || typeof action.keyboard !== "boolean")
        throw new Error("Invalid authored FES button input.");
      if (action.button === 1) throw new Error("FES middle-button input is unsupported.");
      if (action.pointer && ![action.pointer.x, action.pointer.y].every(value => Number.isSafeInteger(value) && Math.abs(value) <= 1048576)) throw new Error("Invalid authored FES button position.");
      const selected = this.retainPointerFocus ? this.keyboardFocus : this.focus;
      const object = action.keyboard ? selected && selected.enabled && this.displayed(selected) ? selected : null : action.pointer ? await this.hitTest(action.pointer.x, action.pointer.y) : null;
      if (action.kind === "down") {
        if (this.pressedButtons.has(action.button)) continue;
        this.pressedButtons.set(action.button, object);
        machine.mouse[action.button === 0 ? "left" : "right"] = object?.handle ?? -1;
        if (object) machine.queueEvent(object, action.button === 0 ? "PUSH_L" : "PUSH_R");
      } else {
        const pressed = this.pressedButtons.get(action.button); this.pressedButtons.delete(action.button);
        if (pressed) machine.queueEvent(pressed, action.button === 0 ? "RELEASE_L" : "RELEASE_R");
      }
    }
  }
  async tick(frame, machine, input = {}) {
    this.machine = machine;
    for (const object of this.objects.values()) {
      if (object.animationEnabled && object.animation) object.animationFrameId = object.animation.tick(frame).frameId;
      for (const motion of object.motions) {
        const previous = AUDIO.has(object.type) ? this.sound.motionState(object) : object.bytes;
        previous.copy(motion.machine.bytes, 0, 0, MOTION.objectBytes); const result = await motion.machine.tick(frame - motion.started);
        if (AUDIO.has(object.type)) await this.sound.applyMotion(object, previous, result.bytes);
        result.bytes.copy(object.bytes);
      }
      object.motions = object.motions.filter(motion => !motion.machine.done);
    }
    await this.processInput(input, machine);
  }
  async startAnimation(object, frame) {
    if (!object.animationName || typeof this.loadAnimation !== "function") throw new Error("FES image animation data is unavailable.");
    if (object.tableMode) throw new Error("FES image animation with an ID table is unsupported.");
    const animation = new ImageAnimation(await this.loadAnimation(object.animationName), { engineVersion: this.engineVersion, signal: this.signal });
    animation.reset(frame); const result = animation.tick(frame);
    object.animation = animation; object.animationFrameId = result.frameId;
  }
  parameter(source, context, current = 0) {
    if (source.includes("@")) throw new Error("FES current-value motion parameters are unsupported.");
    if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(source)) { const value = parseFloat(source); return source.endsWith("%") ? value / 100 : value; }
    return scalar(source, { ...context, current });
  }
  async motion(object, macro, supplied, machine) {
    if (supplied.length > macro.parameters.length || this.motionCount >= LIMITS.motions || typeof this.loadMotion !== "function") throw new Error("FES authored motion arguments or count are unsupported.");
    const values = macro.parameters.map((spec, index) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)\[([^\]]+)\]$/.exec(spec); if (!match) throw new Error("Unsupported FES motion parameter declaration.");
      return this.parameter(supplied[index] ?? match[2], machine.context());
    });
    const parameters = macro.arguments.map(spec => {
      const index = /^\[(\d+)\]$/.exec(spec); if (!index) return this.parameter(spec, machine.context());
      if (Number(index[1]) >= values.length) throw new Error("FES motion parameter reference exceeds its declaration."); return values[Number(index[1])];
    });
    if (!this.motionPrograms.has(macro.implementation)) {
      const promise = this.loadMotion(macro.implementation); this.motionPrograms.set(macro.implementation, promise); promise.catch(() => this.motionPrograms.delete(macro.implementation));
    }
    const audio = AUDIO.has(object.type);
    if (audio && (!this.sound?.motionState || !this.sound.applyMotion)) throw new Error("FES audio motion is unavailable.");
    const previous = audio ? this.sound.motionState(object) : object.bytes;
    const motion = new MotionMachine(await this.motionPrograms.get(macro.implementation), { parameters, initialObject: previous, signal: this.signal });
    const result = await motion.tick(0);
    if (audio) await this.sound.applyMotion(object, previous, result.bytes);
    result.bytes.copy(object.bytes);
    if (!result.done) object.motions.push({ machine: motion, started: machine.frame, mode: macro.mode });
  }
  async command(source, args, machine) {
    const [name, ...values] = args, macro = this.program.macros.get(name);
    const targets = this.resolveTargets(source, machine.currentObject);
    if (!targets) {
      // The recognized native object handlers accept a group of size zero.
      // Restrict this to implemented verbs; unknown commands still fail.
      if (this.engineVersion !== "2.6.1.76" || !/^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]+\])?$/.test(source)) return false;
      if (["disp", "enable", "blend", "setid"].includes(name)) {
        if (values.length !== 1) throw new Error("Unsupported FES object command arguments.");
        const value = machine.value(values[0]);
        if (name === "blend" && (value < 0 || value > 255) || name === "setid" && value < -1) throw new Error("FES object value exceeds its range.");
        return true;
      }
      if (name === "stop" || name === "noact") {
        if (values.length) throw new Error("Unsupported FES object command arguments."); return true;
      }
      if (name === "reset" || name === "layout") {
        if (!this.text?.validateCommand) return false;
        this.text.validateCommand(name, values, machine); return true;
      }
      return false;
    }
    for (const object of targets) {
      if (macro) {
        await this.motion(object, macro, values, machine); continue;
      }
      if (AUDIO.has(object.type)) {
        if (!this.sound?.command || !await this.sound.command(object, name, values, machine)) throw new Error(`FES sound command ${name} is unsupported.`); continue;
      }
      if (name === "anm" || name === "setanm") {
        if (this.engineVersion !== "2.6.1.76" || !["IMAGE", "BUTTON"].includes(object.type) || values.length !== 1)
          throw new Error("This FES image animation command is unsupported.");
        if (name === "setanm") {
          const authored = machine.string(values[0]);
          if (typeof authored !== "string" || Encoding.encode(authored).length > 255) throw new Error("FES image animation name exceeds its range.");
          object.animationName = memberPath(authored); object.animation = null;
          if (object.animationEnabled) await this.startAnimation(object, machine.frame);
        } else {
          const enabled = machine.value(values[0]); if (![0,1].includes(enabled)) throw new Error("FES image animation mode is unsupported.");
          if (enabled) await this.startAnimation(object, machine.frame);
          object.animationEnabled = Boolean(enabled);
        }
        continue;
      }
      if (["pos", "pos2", "getpos", "size", "getsize", "vram", "pri"].includes(name)) {
        if (this.engineVersion !== "2.6.1.76" || !DRAWABLE.has(object.type) && object.type !== "PLANE") throw new Error("This FES geometry command profile is unsupported.");
        if (name === "pos2") {
          if (values.length !== 1) throw new Error("Unsupported FES geometry arguments.");
          const geometry = await imageGeometry(values[0], { engineVersion: this.engineVersion, machine, describeFrame: this.describeFrame });
          object.bytes.writeFloatLE(geometry.x, OFFSET.position); object.bytes.writeFloatLE(geometry.y, OFFSET.position + 4);
        } else if (name === "getpos" || name === "getsize") {
          if (values.length !== 2) throw new Error("Unsupported FES geometry arguments.");
          const output = name === "getpos" ? floats(object.bytes, OFFSET.position).slice(0, 2).map(Math.trunc) : [object.width, object.height];
          const indexes = values.map(value => machine.value(value));
          if (indexes.some(index => index < -1 || index >= machine.globals.length) || output.some(value => !Number.isSafeInteger(value))) throw new Error("FES geometry output exceeds its flag region.");
          indexes.forEach((index, at) => { if (index !== -1) machine.globals[index] = output[at]; });
        } else if (name === "pri") {
          if (values.length !== 1) throw new Error("Unsupported FES geometry arguments."); object.bytes.writeFloatLE(machine.value(values[0]), OFFSET.base + 8);
        } else {
          if (values.length !== 2) throw new Error("Unsupported FES geometry arguments.");
          const coordinates = values.map(value => machine.value(value));
          if (coordinates.some(value => Math.abs(value) > 32768) || name === "size" && (coordinates.some(value => value < 1 || value > LIMITS.dimension) || coordinates[0] * coordinates[1] > 32 * 1024 * 1024))
            throw new Error("FES geometry exceeds its pixel or coordinate limit.");
          if (name === "size") { [object.width, object.height] = coordinates; object.emptyReferencedSize = false; }
          else coordinates.forEach((value, index) => object.bytes.writeFloatLE(value, (name === "pos" ? OFFSET.position : OFFSET.vram) + index * 4));
        }
        continue;
      }
      if (TEXT.has(object.type) && !["disp", "blend", "stop"].includes(name)) {
        if (!this.text?.command || !await this.text.command(object, name, values, machine)) throw new Error(`FES text command ${name} is unsupported.`); continue;
      }
      if (name === "stop") {
        if (values.length || !DRAWABLE.has(object.type) && object.type !== "PLANE") throw new Error("Unsupported FES motion-stop arguments.");
        object.motions = []; continue;
      }
      if (["disp", "blend", "enable", "setid", "noact"].includes(name)) {
        if (values.length !== 1 && !(name === "noact" && values.length === 0)) throw new Error("Unsupported FES object command arguments.");
        const value = values.length ? machine.value(values[0]) : 1;
        if (name === "disp") object.visible = Boolean(value);
        else if (name === "blend") { if (value < 0 || value > 255) throw new Error("FES opacity exceeds its range."); object.bytes[OFFSET.alpha] = value; }
        else {
          if (name !== "setid" && object.type !== "BUTTON" || name === "setid" && !["BUTTON", "IMAGE"].includes(object.type)) throw new Error("FES command requires a compatible image or button.");
          if (name === "enable") object.enabled = Boolean(value);
          else if (name === "noact") this.defaultButton = object;
          else {
            if (object.animationEnabled) throw new Error("FES image selection during animation is unsupported.");
            if (object.tableMode ? !object.idTable.has(value) : value < -1) throw new Error("FES image table entry is absent."); object.selected = value;
            object.animationFrameId = null;
          }
        }
      } else if (name === "load" && ["IMAGE", "BUTTON"].includes(object.type)) {
        if (values.length !== 1) throw new Error("Unsupported FES image load arguments."); object.file = machine.string(values[0]); object.frame = null;
      } else throw new Error(`FES object command ${name} is unsupported.`);
    }
    return true;
  }
}
module.exports = { LIMITS, FrontEndObjects, objectBytes, priorityKey, compareObjects };
