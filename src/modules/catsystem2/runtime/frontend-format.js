const Encoding = require("../encoding");
const LIMITS = Object.freeze({ bytes: 4096, width: 256, values: 4 });
/** FES integer printf fields, with no pointers or implicit argument reads. */
function formatFrontEndString(source, supplied, machine) {
  if (typeof source !== "string" || !Array.isArray(supplied) || supplied.length > LIMITS.values || Encoding.encode(source).length > LIMITS.bytes) throw new Error("FES formatted string exceeds its limit.");
  let index = 0, result = "";
  for (let at = 0; at < source.length;) {
    if (source[at] !== "%") { result += source[at++]; continue; }
    if (source[at + 1] === "%") { result += "%"; at += 2; continue; }
    const field = /^%(0?)(\d*)d/.exec(source.slice(at));
    if (!field || index >= supplied.length || Number(field[2] || 0) > LIMITS.width) throw new Error("This FES formatted string field is unsupported.");
    const value = machine.value(supplied[index++]); if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error("FES formatted integer exceeds its range.");
    const width = Number(field[2] || 0), zero = Boolean(field[1]), text = Math.abs(value).toString();
    const signed = (value < 0 ? "-" : "") + text;
    result += zero ? value < 0 ? "-" + text.padStart(Math.max(0, width - 1), "0") : text.padStart(width, "0") : signed.padStart(width, " ");
    at += field[0].length;
  }
  if (Encoding.encode(result).length > LIMITS.bytes || result.includes("\0")) throw new Error("FES formatted string exceeds its output limit.");
  return result;
}
module.exports = { LIMITS, formatFrontEndString };
