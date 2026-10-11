const Encoding = require("../encoding");
const { OFFSET, LIMITS: MOTION } = require("./motion-vm");
const LIMITS = Object.freeze({ objects: 256, simultaneous: 64, loops: 65535, tableEntries: 4096, tableFilenameBytes: 31 });
const AUDIO = new Set(["SOUND", "SNDTABLE"]);

/** Authored SOUND state. Playback requires a real PCM output adapter. */
function createFrontEndSound({ registry, soundConfig, cache, output, signal } = {}) {
  if (!registry?.read || !soundConfig?.soundFor || !cache?.get) throw new Error("Bounded CatSystem2 sound resources are required.");
  const states = new Map(); let closed = false;
  function state(object) {
    signal?.throwIfAborted(); if (closed || !AUDIO.has(object.type)) throw new Error("The CatSystem2 sound session is unavailable.");
    output?.assertHealthy?.();
    if (!states.has(object)) {
      if (states.size >= LIMITS.objects) throw new Error("CatSystem2 sound objects exceed their session limit.");
      if (object.type === "SNDTABLE" && (!Number.isInteger(object.tableSize) || object.tableSize < 1 || object.tableSize > LIMITS.tableEntries || object.volumeType !== 0))
        throw new Error("The authored CatSystem2 sound table is unsupported.");
      states.set(object, { object, file: object.file, decoded: null, part: null, volume: 100, playing: null, stopOnDispose: true, generation: 0,
        ...(object.type === "SNDTABLE" ? { entries: new Map(), selected: -1, repeat: false } : {}) });
    }
    return states.get(object);
  }
  async function stop(item) {
    item.generation++; const playing = item.playing; item.playing = null; if (playing) await playing.stop();
  }
  async function load(item, filename) {
    const part = soundConfig.soundFor(filename, item.object.soundGroup, item.object.soundType), bytes = await registry.read(part.int, filename);
    const decoded = await cache.get(bytes); signal?.throwIfAborted();
    await stop(item); item.file = filename; item.part = part; item.decoded = decoded;
  }
  function gain(item) {
    const master = soundConfig.master;
    if (![master.volume, item.volume, item.part?.mastervol].every(value => Number.isInteger(value) && value >= 0 && value <= 100)) throw new Error("CatSystem2 sound gain is invalid.");
    return master.mute || item.part.mute ? 0 : master.volume / 100 * item.part.mastervol / 100 * item.volume / 100;
  }
  function motionState(object) {
    const item = state(object);
    if (!Buffer.isBuffer(object.bytes) || object.bytes.length !== MOTION.objectBytes) throw new Error("FES sound motion state has an invalid extent.");
    const bytes = Buffer.from(object.bytes); bytes[OFFSET.alpha] = item.volume; return bytes;
  }
  async function applyMotion(object, previous, next) {
    const item = state(object);
    if (![previous, next].every(bytes => Buffer.isBuffer(bytes) && bytes.length === MOTION.objectBytes)) throw new Error("FES sound motion state has an invalid extent.");
    for (let offset = 0; offset < MOTION.objectBytes; offset++) if (offset !== OFFSET.alpha && previous[offset] !== next[offset])
      throw new Error("This FES sound motion changes unsupported audio fields.");
    const volume = next[OFFSET.alpha]; if (volume > 100) throw new Error("FES sound volume exceeds its range.");
    if (item.volume !== volume) { item.volume = volume; if (item.playing) await item.playing.setGain(gain(item)); }
  }
  async function command(object, name, supplied, machine) {
    const item = state(object), size = (min, max = min) => { if (supplied.length < min || supplied.length > max) throw new Error(`Unsupported FES sound ${name} arguments.`); };
    if (object.type === "SNDTABLE") {
      if (name === "sndtbl") {
        size(3); const index = machine.value(supplied[0]), file = machine.string(supplied[1]), enabled = machine.value(supplied[2]);
        if (!Number.isInteger(index) || index < 0 || index >= object.tableSize || ![0, 1].includes(enabled) || !file || Encoding.encode(file).length > LIMITS.tableFilenameBytes || /[\x00-\x1f]/.test(file))
          throw new Error("FES sound table entry exceeds its range.");
        item.entries.set(index, { file, enabled: Boolean(enabled) }); return true;
      }
      if (name === "setid") {
        size(1); const index = machine.value(supplied[0]);
        if (!Number.isInteger(index) || index < 0 || index >= object.tableSize) throw new Error("FES sound table selection exceeds its range.");
        // The native table scans enabled entries from the requested position.
        // Registering and selecting tracks does not decode or start playback.
        item.selected = -1;
        for (let at = index; at < object.tableSize; at++) if (item.entries.get(at)?.enabled) { item.selected = at; break; }
        return true;
      }
      if (name === "getid") {
        size(1); const index = machine.value(supplied[0]);
        if (!Number.isInteger(index) || index < 0 || index >= machine.globals.length) throw new Error("FES sound table output exceeds its authored flag region.");
        machine.globals[index] = item.selected; return true;
      }
      if (name === "crossfade") {
        size(1, 2); const enabled = machine.value(supplied[0]);
        if (enabled !== 0 || supplied.length === 2 && machine.value(supplied[1]) !== 0) throw new Error("FES sound crossfade is unsupported.");
        return true;
      }
      if (name === "load") throw new Error("FES sound tables require authored sndtbl entries.");
      if (name === "play") {
        if (item.selected < 0) return true;
        const entry = item.entries.get(item.selected);
        if (!entry?.enabled) throw new Error("The selected FES sound table entry is disabled.");
        if (item.file !== entry.file || !item.decoded) await load(item, entry.file);
      }
    }
    if (name === "blend") {
      size(1); const value = machine.value(supplied[0]); if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error("FES sound volume exceeds its range.");
      item.volume = value; if (item.playing) await item.playing.setGain(gain(item));
    } else if (name === "load") { size(1); await load(item, machine.string(supplied[0])); }
    else if (name === "play") {
      size(0, 3); const [loops = 0, end = 1, force = 0] = supplied.map(value => machine.value(value));
      if (!Number.isInteger(loops) || loops < 0 || loops > LIMITS.loops || ![0, 1].includes(end) || ![0, 1].includes(force)) throw new Error("FES sound playback options exceed their range.");
      if (!item.decoded) { if (!item.file) throw new Error("FES sound has no authored audio file."); await load(item, item.file); }
      await stop(item); item.stopOnDispose = Boolean(end);
      if (!soundConfig.master.play || !item.part.play && !force) return true;
      if (!output?.start) throw new Error("Native CatSystem2 PCM output is unavailable.");
      if ([...states.values()].filter(value => value.playing).length >= LIMITS.simultaneous) throw new Error("CatSystem2 simultaneous audio exceeds its limit.");
      const generation = item.generation;
      const playing = await output.start({ decoded: item.decoded, gain: gain(item), loops, signal,
        onFinished: () => { if (closed || generation !== item.generation) return; item.playing = null; if (item.detached) states.delete(object); if (!machine.ended) machine.queueEvent(object, "STOP"); } });
      if (!playing?.stop || !playing.setGain) throw new Error("The CatSystem2 PCM output returned invalid controls."); item.playing = playing.active === false ? null : playing;
      if (!machine.ended) machine.queueEvent(object, "PLAY");
    } else if (name === "stop") { size(0); await stop(item); }
    else return false;
    return true;
  }
  async function dispose(objects) {
    for (const object of objects.objects.values()) {
      const item = states.get(object); if (!item) continue;
      if (item.stopOnDispose || !item.playing) { await stop(item); states.delete(object); }
      else item.detached = true;
    }
  }
  async function close() { closed = true; await Promise.all([...states.values()].map(stop)); states.clear(); }
  return { states, command, motionState, applyMotion, isBusy: object => Boolean(states.get(object)?.playing), dispose, close };
}
module.exports = { LIMITS, createFrontEndSound };
