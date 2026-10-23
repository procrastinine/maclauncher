const { float } = require("./kernel-vm");
const Encoding = require("../encoding");
const LIMITS = Object.freeze({ depth: 8, characters: 4096, width: 256, precision: 32 });

/** Authored KCS printf fields reference byte offsets in G/L/H logical memory. */
function formatKernelBytes(machine, address, depth = 0) {
  if (depth > LIMITS.depth) throw new Error("KCS formatted string recursion exceeds its limit.");
  const source = machine.stringBytes(address), chunks = []; let outputBytes = 0;
  function append(bytes) { if ((outputBytes += bytes.length) > LIMITS.characters) throw new Error("KCS formatted string exceeds its output limit."); chunks.push(bytes); }
  for (let at = 0; at < source.length;) {
    if (source[at] !== 0x25) { const next = source.indexOf(0x25, at); const end = next < 0 ? source.length : next; append(source.subarray(at, end)); at = end; }
    else if (source[at + 1] === 0x25) { append(Buffer.from("%")); at += 2; }
    else {
      const field = /^%([-+ 0#]*)(\d*)(?:\.(\d+))?([diuxXofFeEgGsScC])\[([GLH])(\d+)\]/.exec(source.subarray(at, at + 512).toString("latin1"));
      if (!field) {
        // The original formatter leaves percent text without a bracketed
        // memory field unchanged (including later host language substitutions).
        if (/^%[^\s%]{0,63}\[/.test(source.subarray(at, at + 64).toString("latin1"))) throw new Error("KCS formatted string field is unsupported.");
        append(Buffer.from("%")); at++; continue;
      }
      const [, flags, widthText, precisionText, kind, region, offsetText] = field;
      const width = Number(widthText || 0), precision = precisionText == null ? null : Number(precisionText), offset = Number(offsetText);
      if (!Number.isSafeInteger(offset) || width > LIMITS.width || precision != null && precision > LIMITS.precision || new Set(flags).size !== flags.length) throw new Error("KCS formatted string field exceeds its bounds.");
      const logical = region === "H" ? (offset | 0x80000000) >>> 0 : offset + (region === "L" ? machine.argumentBase : 0);
      let text, bytes;
      if (kind.toLowerCase() === "s") {
        bytes = formatKernelBytes(machine, logical, depth + 1).subarray(0, precision ?? LIMITS.characters);
        const padding = Buffer.alloc(Math.max(0, width - bytes.length), 32);
        append(flags.includes("-") ? Buffer.concat([bytes, padding]) : Buffer.concat([padding, bytes])); at += field[0].length; continue;
      }
      else {
        const range = machine.resolve(logical), raw = range.bytes.readUInt32LE(range.offset); let value;
        if ("fFeEgG".includes(kind)) {
          value = float(raw); if (!Number.isFinite(value)) throw new Error("KCS formatted floating value is not finite.");
          const digits = precision ?? 6;
          text = kind.toLowerCase() === "f" ? value.toFixed(digits) : kind.toLowerCase() === "e" ? value.toExponential(digits) : value.toPrecision(digits || 1);
          if (kind === kind.toUpperCase()) text = text.toUpperCase();
        } else if (kind.toLowerCase() === "c") text = String.fromCharCode(raw & 255);
        else {
          value = "di".includes(kind) ? raw | 0 : raw;
          const base = kind.toLowerCase() === "x" ? 16 : kind === "o" ? 8 : 10;
          text = Math.abs(value).toString(base); if (kind === "X") text = text.toUpperCase();
          if (precision != null) text = text.padStart(precision, "0");
          if (flags.includes("#") && raw && base !== 10) text = (base === 16 ? kind === "X" ? "0X" : "0x" : "0") + text;
          if (value < 0) text = "-" + text;
        }
        if (value != null && value >= 0 && flags.includes("+")) text = "+" + text;
        else if (value != null && value >= 0 && flags.includes(" ")) text = " " + text;
      }
      if (flags.includes("-")) text = text.padEnd(width, " ");
      else if (flags.includes("0") && !"sScC".includes(kind) && precision == null && /^[+ -]/.test(text)) text = text[0] + text.slice(1).padStart(Math.max(0, width - 1), "0");
      else text = text.padStart(width, flags.includes("0") && !"sScC".includes(kind) && precision == null ? "0" : " ");
      append(Buffer.from(text, "latin1")); at += field[0].length;
    }
  }
  return Buffer.concat(chunks, outputBytes);
}
const formatKernelString = (machine, address) => Encoding.decode(formatKernelBytes(machine, address));
module.exports = { LIMITS, formatKernelString, formatKernelBytes };
