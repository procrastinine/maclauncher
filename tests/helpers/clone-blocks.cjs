const ChildProcess = require("node:child_process"), fs = require("node:fs");

// F_LOG2PHYS_EXT reports where a file's first block lives; APFS clones share
// it until a write. Returns null when this Mac cannot report it.
function physicalOffset(file) {
  if (process.platform !== "darwin" || ChildProcess.spawnSync("/usr/bin/xcode-select", ["-p"]).status !== 0) return null;
  const script = "import fcntl,os,struct,sys\nfd=os.open(sys.argv[1],os.O_RDONLY)\nprint(struct.unpack('<Iqq',fcntl.fcntl(fd,65,struct.pack('<Iqq',0,4096,0)))[2])";
  const result = ChildProcess.spawnSync("/usr/bin/python3", ["-I", "-c", script, file], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
// Whether a clone of the file beside it reports shared blocks: false on a
// volume without clones, and also when this Mac cannot report them.
function clonesBeside(file) {
  const origin = physicalOffset(file), probe = file + ".clone-probe";
  if (origin === null) return false;
  try {
    ChildProcess.execFileSync("/bin/cp", ["-c", file, probe]);
    return physicalOffset(probe) === origin;
  } finally { fs.rmSync(probe, { force: true }); }
}

module.exports = { physicalOffset, clonesBeside };
