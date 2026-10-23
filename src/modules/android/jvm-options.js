// Original AOSP URL handlers, algorithm-name lookup and Conscrypt's reflective
// TLS-session status query use JDK implementations. Android's desugared collection
// wrappers also access the original JDK collection delegates and monitor fields.
// Android SystemCleaner also delegates resource cleanup to the JDK's shared
// CleanerFactory. The JDK retains ownership; these exports/opens do not replace
// its implementations or introduce a second cleaner/thread lifecycle.
const frameworkJvmOptions = Object.freeze([
  "--add-exports=java.base/jdk.internal.ref=ALL-UNNAMED",
  "--add-exports=java.base/sun.net.www.protocol.jar=ALL-UNNAMED",
  "--add-exports=java.base/sun.net.www=ALL-UNNAMED",
  "--add-exports=java.base/sun.security.x509=ALL-UNNAMED",
  "--add-exports=java.base/sun.security.jca=ALL-UNNAMED",
  "--add-exports=java.base/sun.security.pkcs=ALL-UNNAMED",
  "--add-opens=java.base/sun.security.ssl=ALL-UNNAMED",
  "--add-opens=java.base/java.util=ALL-UNNAMED",
  "--add-opens=java.base/java.nio=ALL-UNNAMED",
  "--add-opens=java.base/java.io=ALL-UNNAMED",
  "--add-opens=java.base/jdk.internal.foreign=ALL-UNNAMED",
]);
// Application processes retain the original host defining loader while system
// lookups can reach the APK's current loader. Older runtime generations keep
// their existing startup options until their host archive declares this API.
function applicationJvmOptions(payload) {
  const version = payload.profile?.applicationSystemClassLoaderVersion;
  if (version == null) return [];
  if (version !== 1) throw new Error("The Android application class loader is unsupported.");
  return [
    "--add-opens=java.base/jdk.internal.loader=ALL-UNNAMED",
    "-Djava.system.class.loader=maclauncher.android.framework.HostSystemClassLoader",
  ];
}
// java.security uses java.util.Properties byte/continuation semantics. Read the
// selected JDK's configuration without initializing a provider in the game JVM.
function securityProperties(bytes) {
  const result = new Map(), lines = bytes.toString("latin1").split(/\r\n|\n|\r/);
  const decode = value => {
    let output = "";
    for (let i = 0; i < value.length; i++) {
      if (value[i] !== "\\") { output += value[i]; continue; }
      const next = value[++i];
      if (next === "u") {
        const hex = value.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("Invalid Java security property escape.");
        output += String.fromCharCode(parseInt(hex, 16)); i += 4;
      } else output += ({ t: "\t", n: "\n", r: "\r", f: "\f" })[next] ?? next ?? "";
    }
    return output;
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    while ((line.match(/\\+$/)?.[0].length || 0) % 2 === 1)
      line = line.slice(0, -1) + (lines[++i] || "").replace(/^[ \t\f]+/, "");
    line = line.replace(/^[ \t\f]+/, "");
    if (!line || line[0] === "#" || line[0] === "!") continue;
    let end = 0;
    for (; end < line.length; end++) {
      if (line[end] === "\\") { end++; continue; }
      if (/[=: \t\f]/.test(line[end])) break;
    }
    const key = decode(line.slice(0, end));
    let value = end;
    while (/[ \t\f]/.test(line[value] || "\0")) value++;
    if (line[value] === "=" || line[value] === ":") value++;
    while (/[ \t\f]/.test(line[value] || "\0")) value++;
    result.set(key, decode(line.slice(value)));
  }
  return result;
}

function cryptoJvmOptions({ javaHome, runtimeRoot, cacheRoot, javaArguments = [] }) {
  const fs = require("node:fs"), path = require("node:path");
  if (javaArguments.some(value => value === "-Djava.security.properties" || value.startsWith("-Djava.security.properties="))) return [];
  const catalog = path.join(runtimeRoot, "java-security.properties");
  if (!fs.existsSync(catalog)) return [];
  const configured = securityProperties(fs.readFileSync(path.join(javaHome, "conf/security/java.security")));
  if (configured.get("security.overridePropertiesFile")?.toLowerCase() !== "true") return [];
  const property = "jdk.security.provider.preferred";
  const previous = configured.get(property)?.trim() || "";
  const defaults = securityProperties(fs.readFileSync(catalog)).get(property)?.trim() || "";
  if (!defaults) return [];
  const entries = new Set(previous.split(",").map(value => value.trim().toLowerCase()));
  const appended = defaults.split(",").map(value => value.trim()).filter(value => {
    const key = value.toLowerCase(); if (!value || entries.has(key)) return false;
    entries.add(key); return true;
  });
  const preference = [previous, ...appended].filter(Boolean).join(",");
  const encoded = preference.replace(/[\\\u0000-\u001f\u007f-\uffff]/g, value => {
    const escaped = { "\\": "\\\\", "\t": "\\t", "\n": "\\n", "\r": "\\r", "\f": "\\f" }[value];
    return escaped || "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0");
  });
  const file = path.join(cacheRoot, "java-security.properties"), contents = property + "=" + encoded + "\n";
  let previousBytes;
  try { previousBytes = fs.readFileSync(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previousBytes !== contents) require("../shared/writable-input").atomicWrite(file, contents, { root: cacheRoot });
  return ["-Djava.security.properties=" + file];
}
module.exports = { frameworkJvmOptions, applicationJvmOptions, cryptoJvmOptions, securityProperties };
