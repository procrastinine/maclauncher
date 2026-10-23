const namespace = require("./runtime-source").json("native/resources/storage-namespace.json");

const namespaceKeys = Object.freeze([...Object.keys(namespace.environment), ...Object.keys(namespace.partitions)]);
const systemKeys = Object.freeze(["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
const variable = "KL_ANDROID_NATIVE_STARTUP_ENVIRONMENT";

/** Encode an explicitly admitted environment, independently of the host process. */
function encodeEnvironment(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Invalid Android startup environment.");
  const keys = Object.keys(values).sort();
  if (keys.length > 64) throw new Error("Android startup environment exceeds its limit.");
  const parts = [];
  let size = 0;
  for (const key of keys) {
    const value = values[key];
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0"))
      throw new Error("Invalid Android startup environment.");
    if ((size += key.length + Buffer.byteLength(value, "utf8") + 2) > 16384)
      throw new Error("Android startup environment exceeds its limit.");
    parts.push(Buffer.from(key + "=" + value + "\0", "utf8"));
  }
  return "1:" + Buffer.concat(parts, size).toString("base64url");
}

/** Namespace paths and the launcher's already admitted locale settings only. */
function environment({ androidEnvironment, systemEnvironment, home, temporary }) {
  const values = Object.create(null);
  for (const [keys, source] of [[namespaceKeys, androidEnvironment], [systemKeys, systemEnvironment]])
    for (const key of keys)
      if (Object.hasOwn(source, key)) values[key] = source[key];
  values.HOME = home;
  values.TMPDIR = temporary;
  return { [variable]: encodeEnvironment(values) };
}

module.exports = { encodeEnvironment, environment };
