const Text = require("./coretext-raster"), { memberPath } = require("../startup");
const PROFILE = "2.6.1.76", LIMITS = Object.freeze({ fonts: 64, fontBytes: 64 * 1024 * 1024, textBytes: 8192 });
const integer = (value, low, high) => Number.isSafeInteger(value) && value >= low && value <= high;

/** Explicit STRING8 state with original fonts and derived, immutable pixels. */
function createFrontEndText({ engineVersion, registry, cache, getFontSizeIndex, signal } = {}) {
  if (engineVersion !== PROFILE || !registry?.read || !registry?.locate || !registry?.verify || !cache?.get)
    throw new Error("This CatSystem2 text profile or renderer is unavailable.");
  const states = new WeakMap(), fonts = new Map(), pendingFonts = new Map(); let fontBytes = 0;
  // These layout values are initialized by the original UTF-8 object. A
  // native Windows font/shadow preference needs an explicit supported choice.
  const defaults = () => ({ fontSizes: [24,24,24,24,24], rubySizes: [10,10,10,10,10], rubyPosition: 0, indent: 0, fontFix: 0,
    proportionalMode: null, proportionalEnabled: null, profileClears: [false,false,false,false], profile: null,
    margin: [0,0,0,0], move: [0,0], colors: [255,255,255,0,0,0,255,255,255],
    frames: 2, font: null, shadow: null, view: null, rendered: null });
  function state(object) {
    if (!object || object.type !== "STRING8" || typeof object.textContent !== "string") throw new Error("This FES text object is unsupported.");
    if (!states.has(object)) states.set(object, defaults()); return states.get(object);
  }
  function validateCommand(name, values, machine) {
    signal?.throwIfAborted();
    if (!Array.isArray(values) || !machine?.value || !machine?.string) throw new Error("Invalid FES text arguments.");
    const numbers = (low, high) => values.map(value => { const number = machine.value(value); if (!integer(number, low, high)) throw new Error("FES text layout exceeds its range."); return number; });
    if (name === "reset" || name === "clear") { if (values.length) throw new Error("Unsupported FES text arguments."); return { name }; }
    if (name === "endpos") {
      if (values.length !== 2 || !machine.globals) throw new Error("Unsupported FES text output arguments."); return { name, values: numbers(-1, machine.globals.length - 1) };
    }
    if (name === "str" || name === "apend") {
      if (values.length !== 1) throw new Error("Unsupported FES text arguments.");
      const text = machine.string(values[0]);
      if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > LIMITS.textBytes || /[\x00-\x09\x0b-\x1f\x7f\\]/.test(text)) throw new Error("This FES text escape or encoding is unsupported.");
      return { name, text };
    }
    if (name !== "layout" || !values.length) throw new Error(`FES text command ${name} is unsupported.`);
    const [mode, ...supplied] = values, read = (count, low, high) => {
      if (supplied.length !== count) throw new Error("Unsupported FES text layout arguments.");
      return supplied.map(source => { const number = machine.value(source); if (!integer(number, low, high)) throw new Error("FES text layout exceeds its range."); return number; });
    };
    if (mode === "margin") return { name, mode, values: read(4, 0, Text.LIMITS.dimension) };
    if (mode === "move") return { name, mode, values: read(2, -128, 256) };
    if (mode === "color") return { name, mode, values: read(9, 0, 255) };
    if (mode === "view") return { name, mode, values: read(2, 1, Text.LIMITS.dimension) };
    if (mode === "vdraw") return { name, mode, values: read(1, 0, 1), inert: true };
    if (mode === "ruby") return { name, mode, values: read(1, 0, 0) };
    if (["indent", "fontfix", "profmode", "prof_enable"].includes(mode)) return { name, mode, values: read(1, 0, 1) };
    if (mode === "c_prof") return { name, mode, values: read(1, 0, 3) };
    if (mode === "prof") {
      if (supplied.length !== 2) throw new Error("Unsupported FES text profile arguments.");
      const index = machine.value(supplied[0]), prefix = machine.string(supplied[1]);
      if (!integer(index, 0, 3) || typeof prefix !== "string" || Buffer.byteLength(prefix, "utf8") > LIMITS.textBytes || /[\x00-\x1f\x7f\\]/.test(prefix))
        throw new Error("This FES text profile is unsupported.");
      return { name, mode, index, prefix };
    }
    if (mode === "size" || mode === "rsize") {
      if (![1, 5].includes(supplied.length)) throw new Error("Unsupported FES font-size table.");
      const sizes = read(supplied.length, 1, 256); return { name, mode, values: sizes.length === 1 ? Array(5).fill(sizes[0]) : sizes };
    }
    if (mode === "frame") return { name, mode, values: read(1, 0, 10000) };
    if (mode === "shadow") {
      if (![1,2].includes(supplied.length)) throw new Error("Unsupported FES shadow arguments.");
      const shadow = read(supplied.length, 0, 1); if (shadow.some(Boolean)) throw new Error("This FES text shadow is unsupported."); return { name, mode, values: shadow };
    }
    if (mode === "fontind") {
      if (supplied.length !== 2 || machine.value(supplied[0]) !== 1) throw new Error("This FES font-selection mode is unsupported.");
      const font = memberPath(machine.string(supplied[1])); if (!/\.(?:ttf|otf)$/i.test(font)) throw new Error("This FES font format is unsupported."); return { name, mode, font };
    }
    throw new Error(`FES text layout ${mode} is unsupported.`);
  }
  async function originalFont(name) {
    const located = await registry.locate("font", name); await registry.verify(located);
    const identity = located.sourcePath ? `${located.observation?.path}:${located.observation?.identity}` : `${located.archive?.path}:${located.entry?.index}`;
    if (fonts.has(identity)) return fonts.get(identity);
    if (pendingFonts.has(identity)) return pendingFonts.get(identity);
    if (fonts.size + pendingFonts.size >= LIMITS.fonts) throw new Error("CatSystem2 fonts exceed their cache limit.");
    const operation = (async () => {
      const bytes = await registry.read("font", name, { maximumBytes: Text.LIMITS.fontBytes }); await registry.verify(located); signal?.throwIfAborted();
      if (!Buffer.isBuffer(bytes) || bytes.length > Text.LIMITS.fontBytes || fontBytes + bytes.length > LIMITS.fontBytes) throw new Error("CatSystem2 fonts exceed their byte limit.");
      fontBytes += bytes.length; fonts.set(identity, bytes); return bytes;
    })();
    pendingFonts.set(identity, operation); try { return await operation; } finally { pendingFonts.delete(identity); }
  }
  async function frame(object) {
    signal?.throwIfAborted(); const layout = state(object); if (!object.textContent) return null;
    if (layout.frames !== 0) throw new Error("This FES text animation is unsupported.");
    if (layout.indent || layout.fontFix || layout.proportionalMode !== null || layout.proportionalEnabled !== null || layout.profile || layout.profileClears.some(Boolean))
      throw new Error("This FES text indentation or proportional layout is unsupported.");
    if (!layout.font || layout.shadow !== "none") throw new Error("The FES font or shadow layout is unsupported.");
    let index = 0;
    if (new Set(layout.fontSizes).size > 1) {
      if (typeof getFontSizeIndex !== "function") throw new Error("FES font-size preference selection is unavailable.");
      index = getFontSizeIndex(); if (!integer(index, 0, 4)) throw new Error("FES font-size preference exceeds its table.");
    }
    const [width, height] = layout.view || [object.width, object.height], request = { width, height, fontSize: layout.fontSizes[index],
      margin: layout.margin, color: layout.colors.slice(0,3), letterSpacing: layout.move[0], lineSpacing: layout.move[1], shadow: layout.shadow, alignment: "left", text: object.textContent };
    const rendered = await cache.get(await originalFont(layout.font), request); layout.rendered = rendered; return rendered;
  }
  async function command(object, name, values, machine) {
    const operation = validateCommand(name, values, machine), layout = state(object);
    // This exact runner version leaves the legacy vdraw setting unchanged.
    // Other unimplemented layout names are rejected by validateCommand.
    if (operation.inert) return true;
    if (name === "reset") states.set(object, defaults());
    else if (name === "clear") { object.textContent = ""; layout.rendered = null; }
    else if (name === "str" || name === "apend") {
      const text = name === "str" ? operation.text : object.textContent + operation.text;
      if (Buffer.byteLength(text, "utf8") > LIMITS.textBytes) throw new Error("FES text exceeds its byte limit."); object.textContent = text; layout.rendered = null;
    } else if (name === "endpos") {
      const rendered = object.textContent ? await frame(object) : null, output = rendered ? [Math.trunc(rendered.endX), Math.trunc(rendered.endY)] : [0,0];
      if (!output.every(value => integer(value, -32768, 32768))) throw new Error("FES text metrics exceed their flag region.");
      operation.values.forEach((index, at) => { if (index !== -1) machine.globals[index] = output[at]; });
    } else {
      const fields = { margin: "margin", move: "move", color: "colors", size: "fontSizes", rsize: "rubySizes", view: "view" };
      if (fields[operation.mode]) layout[fields[operation.mode]] = operation.values;
      else if (operation.mode === "frame") layout.frames = operation.values[0];
      else if (operation.mode === "shadow") layout.shadow = "none";
      else if (operation.mode === "fontind") layout.font = operation.font;
      else if (operation.mode === "ruby") layout.rubyPosition = operation.values[0];
      else if (operation.mode === "indent") layout.indent = operation.values[0];
      else if (operation.mode === "fontfix") layout.fontFix = operation.values[0];
      else if (operation.mode === "profmode") layout.proportionalMode = operation.values[0];
      else if (operation.mode === "prof_enable") layout.proportionalEnabled = operation.values[0];
      else if (operation.mode === "c_prof") layout.profileClears[operation.values[0]] = true;
      else if (operation.mode === "prof") layout.profile = { index: operation.index, prefix: operation.prefix };
      layout.rendered = null;
    }
    return true;
  }
  function close() { fonts.clear(); fontBytes = 0; }
  return { validateCommand, command, frame, close };
}
module.exports = { PROFILE, LIMITS, createFrontEndText };
