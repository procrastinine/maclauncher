const LIMITS = Object.freeze({ text: 32768, count: 256, argument: 16384 });

function validate(values) {
  if (!Array.isArray(values) || values.length > LIMITS.count || values.some(value =>
    typeof value !== "string" || value.length > LIMITS.argument || value.includes("\0")) ||
    values.reduce((total, value) => total + value.length, 0) > LIMITS.text)
    throw new Error("Launch arguments exceed their size limit or contain invalid text.");
  return [...values];
}

// Tokenize argument text only. No shell, substitutions, globbing or operators.
function parse(value = "") {
  if (typeof value !== "string" || value.length > LIMITS.text || value.includes("\0"))
    throw new Error("Launch arguments must be text of at most 32768 characters without null characters.");
  const values = [];
  let token = "", quote = null, started = false;
  const push = () => { if (started) values.push(token); token = ""; started = false; };
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'") quote = null; else token += character;
    } else if (character === "\\") {
      const next = value[index + 1];
      if (next === undefined) throw new Error("Launch arguments end with an incomplete escape. Add a character after the backslash or quote the argument.");
      if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) token += character;
      else { index++; if (next !== "\n") { token += next; started = true; } }
    } else if (quote === '"') {
      if (character === '"') quote = null; else token += character;
    } else if (character === "'" || character === '"') {
      quote = character; started = true;
    } else if (/\s/.test(character)) push();
    else { token += character; started = true; }
  }
  if (quote) throw new Error("Launch arguments contain an unclosed quote. Close the quote before saving.");
  push();
  return validate(values);
}

module.exports = { LIMITS, parse, validate };
