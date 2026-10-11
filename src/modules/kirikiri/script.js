const { TextDecoder } = require("node:util");

function decode(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(bytes.subarray(2));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("shift_jis", { fatal: true }).decode(bytes); }
}

function declaredVersion(bytes) {
  const text = decode(bytes);
  if (text.includes("\0")) return null;
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const kag = code.match(/^[\t ]*(?:var[\t ]+|global\.)?kagVersion[\t ]*=[\t ]*["']([23]\.\d+[A-Za-z0-9 ._-]{0,70})["']/im)?.[1];
  const tjs = code.match(/^[\t ]*(?:var[\t ]+|global\.)?tjsVersion[\t ]*=[\t ]*["']?([12])(?:["';\s]|$)/im)?.[1];
  return kag || tjs ? { kag, tjs } : null;
}

function* tokens(text) {
  // This scanner recognizes only enough syntax to preserve an existing
  // optional-plugin catch. Strings/comments stay opaque and are never run.
  for (let at = 0; at < text.length;) {
    if (/\s/.test(text[at])) { at++; continue; }
    if (text.startsWith("//", at)) { const end = text.indexOf("\n", at + 2); at = end < 0 ? text.length : end; continue; }
    if (text.startsWith("/*", at)) { const end = text.indexOf("*/", at + 2); at = end < 0 ? text.length : end + 2; continue; }
    const start = at, quote = text[at];
    if (quote === '"' || quote === "'") {
      at++;
      while (at < text.length) { if (text[at] === "\\") at += 2; else if (text[at++] === quote) break; }
      yield { start, end: at, string: text.slice(start + 1, at - 1), value: null };
      continue;
    }
    if (quote === "/") {
      // Conservatively keep slash-delimited expressions opaque as well. A
      // division expression may skip a match; it cannot create a rewrite.
      let end = at + 1;
      while (end < text.length && !/[\r\n]/.test(text[end])) { if (text[end] === "\\") end += 2; else if (text[end++] === "/") break; }
      if (text[end - 1] === "/") { at = end; yield { start, end, value: null }; continue; }
    }
    if (/[A-Za-z_$]/.test(quote)) { at++; while (at < text.length && /[A-Za-z0-9_$]/.test(text[at])) at++; }
    else at++;
    yield { start, end: at, value: text.slice(start, at) };
  }
}

function signalUnavailableOptionalPlugins(text) {
  if (!text.includes("Plugins") || !/\.dll["']/i.test(text)) return text;
  const window = [], edits = [], syntax = ["try", "{", "Plugins", ".", "link", "(", null, ")", ";", "}", "catch"];
  for (const token of tokens(text)) {
    window.push(token); if (window.length > syntax.length) window.shift();
    if (window.length !== syntax.length || !syntax.every((value, i) => value === null || window[i].value === value)) continue;
    const plugin = window[6].string;
    if (!/^[A-Za-z0-9_.-]{1,128}\.dll$/i.test(plugin || "")) continue;
    edits.push({ start: window[2].start, end: window[8].end,
      text: `throw new Exception(${JSON.stringify(`Windows plugin unavailable: ${plugin}`)});` });
  }
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function requiredNativeFeatures(text) {
  const window = [], found = new Set();
  const methods = { "Storages.dirlist": "storage.dirlist", "System.addFont": "system.addFont", "global.AdjustMoni": "monitor.adjust" };
  for (const token of tokens(text)) {
    window.push(token); if (window.length > 4) window.shift();
    if (window.length === 4 && window[1].value === "." && window[3].value === "(") {
      const feature = methods[`${window[0].value}.${window[2].value}`];
      if (feature) found.add(feature);
    }
  }
  return [...found].sort();
}

module.exports = { decode, declaredVersion, signalUnavailableOptionalPlugins, requiredNativeFeatures };
