const decoder = new TextDecoder("utf-8", { fatal: true });
const LIMITS = Object.freeze({ bytes: 16 * 1024 * 1024, languages: 16, messages: 250000, stringBytes: 64 * 1024 });

function inspectLocalization(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 10 || bytes.length > LIMITS.bytes || bytes.subarray(0, 4).toString("ascii") !== "CSTL" || bytes.readUInt32LE(4) !== 0)
    throw new Error("Unsupported CSTL localization header.");
  let cursor = 8;
  function integer(maximum) {
    let value = 0, byte;
    do {
      if (cursor >= bytes.length) throw new Error("Truncated CSTL integer.");
      byte = bytes[cursor++]; value += byte;
      if (value > maximum) throw new Error("CSTL count exceeds its limit.");
    } while (byte === 255);
    return value;
  }
  function string(maximum = LIMITS.stringBytes) {
    const length = integer(maximum);
    if (length > bytes.length - cursor) throw new Error("CSTL string exceeds its source range.");
    const text = decoder.decode(bytes.subarray(cursor, cursor + length)); cursor += length;
    if (text.includes("\0")) throw new Error("Unsupported CSTL embedded string terminator.");
    return text;
  }
  const languageCount = integer(LIMITS.languages);
  if (!languageCount) throw new Error("CSTL has no declared languages.");
  const languages = Array.from({ length: languageCount }, () => string(64));
  if (languages.some(name => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) || new Set(languages.map(name => name.toLowerCase())).size !== languageCount)
    throw new Error("CSTL language names are invalid or ambiguous.");
  const messageCount = integer(LIMITS.messages), messages = [];
  for (let index = 0; index < messageCount; index++) {
    const localizations = languages.map(language => ({ language, name: string(), text: string() }));
    messages.push({ index, localizations });
  }
  if (cursor !== bytes.length) throw new Error("Unsupported CSTL trailing data.");
  return { format: "CSTL", sourceEncoding: "UTF-8", languages, messageCount, messages, storedBytes: bytes.length };
}

function decompile(localization) {
  return localization.messages.flatMap(message => message.localizations.map(line => `[${message.index}:${line.language}] ${line.name ? line.name + ": " : ""}${line.text}`)).join("\n") + "\n";
}
module.exports = { LIMITS, inspectLocalization, decompile };
