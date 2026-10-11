const { tokens } = require("../frontend-parser");

function codePart(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    else if (!quoted && line[index] === "/" && line[index + 1] === "/") return line.slice(0, index);
  }
  return line;
}

/** ASCII controls may carry opaque UTF-8 comments, diagnostics and glyph lists. */
function runtimeSource(decoded, { engineVersion } = {}) {
  if (!decoded || typeof decoded.text !== "string") throw new Error("A validated FES source is required.");
  if (decoded.sourceEncoding === "CP932") return decoded.text;
  if (engineVersion !== "2.6.1.76" || decoded.sourceEncoding !== "UTF-8") throw new Error("This FES runtime text encoding is unsupported.");
  for (const line of decoded.text.split(/\r?\n/)) {
    const source = codePart(line); if (!/[^\x00-\x7f]/.test(source)) continue;
    // These bytes cannot identify an object, path, expression or game string.
    // The final prof parameter is an opaque prohibited-glyph list; interpreting
    // that layout setting remains the string object's explicit operation.
    const words = tokens(source);
    const diagnostic = words.length === 2 && words[0] === "dbgstr";
    const prohibitedGlyphs = words.length === 5 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[0]) && words[1] === "layout" && words[2] === "prof";
    if ((!diagnostic && !prohibitedGlyphs) || words.slice(0, -1).some(word => /[^\x00-\x7f]/.test(word)) ||
        /[^\x00-\x7f]/.test(source.replace(words.at(-1), "")))
      throw new Error("This FES executable string encoding is unsupported.");
  }
  return decoded.text;
}
module.exports = { runtimeSource };
