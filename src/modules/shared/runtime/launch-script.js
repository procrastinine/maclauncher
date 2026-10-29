const fs = require("node:fs");
const path = require("node:path");

function readShellInterpreter(script, { fallback = false, env = process.env } = {}) {
  const fd = fs.openSync(script, "r");
  let header;
  try {
    const buffer = Buffer.alloc(4096);
    header = buffer.subarray(0, fs.readSync(fd, buffer)).toString("utf8").split("\n", 1)[0].trim();
  } finally { fs.closeSync(fd); }
  const shebang = header.match(/^#!\s*(\/[^\s]+)(?:\s+(.+))?$/);
  let executable = shebang?.[1], flags = shebang?.[2] ? [shebang[2]] : [];
  if (executable && path.basename(executable) === "env") {
    const words = (shebang[2] || "").split(/\s+/);
    if (words[0] === "-S") words.shift();
    else if (words.length !== 1) return null;
    const name = words.shift();
    if (!/^(?:sh|bash|dash|ksh|zsh)$/.test(name || "")) return null;
    executable = (env.PATH || "/usr/bin:/bin").split(path.delimiter).filter(path.isAbsolute)
      .map(directory => path.join(directory, name)).find(file => {
        try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
      });
    if (!executable) throw new Error(`The script requires ${name}. Install that interpreter or add it to PATH.`);
    flags = words;
  }
  if (!shebang && fallback) {
    executable = { ".sh": "/bin/sh", ".command": "/bin/sh", ".bash": "/bin/bash", ".zsh": "/bin/zsh" }[path.extname(script).toLowerCase()];
  }
  if (!executable || !["sh", "bash", "dash", "ksh", "zsh"].includes(path.basename(executable)) ||
      flags.some(flag => !/^(?:-[a-zA-Z]+|--noprofile|--norc)$/.test(flag) || /^-[^-]*[cso]/.test(flag))) return null;
  return { executable, flags };
}

function isShellScript(script) {
  return Boolean(readShellInterpreter(script));
}

async function launchScript(script, args, options, needsRosetta, context, { allowUnexecutable = false } = {}) {
  const effects = await context.getGameEffectsEnvironment?.({needsRosetta});
  if (!effects?.DYLD_INSERT_LIBRARIES && !allowUnexecutable) {
    return context.spawnDetachedChecked(script, args, options, needsRosetta);
  }
  const shebang = readShellInterpreter(script, { fallback: allowUnexecutable, env: options?.env || process.env });
  if (!shebang) return context.spawnDetachedChecked(script, args, options, needsRosetta);
  if (!effects?.DYLD_INSERT_LIBRARIES) {
    return context.spawnDetachedChecked(shebang.executable, [...shebang.flags, script, ...args], options, needsRosetta);
  }
  // macOS removes DYLD variables on entry to its protected shell. Restore them
  // from positional arguments after that boundary, then source the untouched
  // publisher script with its original $0, arguments and working directory.
  const env = context.applyGameEnvironment
    ? await context.applyGameEnvironment(options?.env, {needsRosetta})
    : { ...(options?.env || process.env), ...effects };
  const variables = Object.entries(env).filter(([key, value]) =>
    /^DYLD_[A-Z0-9_]+$/.test(key) && typeof value === "string" && !value.includes("\0"));
  const restore = variables.map(([key]) => `export ${key}="$1"; shift`).join("; ");
  const parameters = [...shebang.flags, "-c", `${restore}; . "$0"`, script,
    ...variables.map(([, value]) => value), ...args];
  return context.spawnDetachedChecked(shebang.executable, parameters, { ...options, env,
    graphicsExecutable: Object.hasOwn(options || {}, "graphicsExecutable") ? options.graphicsExecutable : null }, needsRosetta);
}

module.exports = { readShellInterpreter, isShellScript, launchScript };
