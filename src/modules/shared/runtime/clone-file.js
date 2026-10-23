const fs = require("node:fs");
const { spawnSync, execFile } = require("node:child_process");
// libuv does not implement forced Darwin cloning in all supported Node builds.
// Call the system API directly: cp -c can silently copy an entire large asset.
const CLONE_SCRIPT = `ObjC.import("Foundation");
ObjC.bindFunction("clonefile", ["int", ["char *", "char *", "unsigned int"]]);
function run() {
  const rows = JSON.parse($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js);
  for (const row of rows) if ($.clonefile(row[0], row[1], 0) !== 0) throw Error("This volume cannot clone the application or game files.");
}`;
function cloneFiles(rows) {
  for (let index = 0; index < rows.length; index++) {
    const [source, output] = rows[index];
    try {
      if (!fs.constants.COPYFILE_FICLONE_FORCE) throw Object.assign(Error("Forced cloning is unavailable."), {code: "ENOSYS"});
      fs.copyFileSync(source, output, fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "ENOSYS" || process.platform !== "darwin") throw error;
      const result = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", "-e", CLONE_SCRIPT],
        {input: JSON.stringify(rows.slice(index)), encoding: "utf8", timeout: 30000, maxBuffer: 65536});
      if (result.error) throw result.error;
      if (result.status !== 0) throw Error("This volume cannot clone the application or game files.");
      return;
    }
  }
}
async function prepareClones(rows, signal) {
  for (let index = 0; index < rows.length; index++) {
    signal?.throwIfAborted();const [source, output] = rows[index];
    try {
      if (!fs.constants.COPYFILE_FICLONE_FORCE) throw Object.assign(Error("Forced cloning is unavailable."), {code: "ENOSYS"});
      await fs.promises.copyFile(source, output, fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "ENOSYS" || process.platform !== "darwin") throw error;
      try {
        await new Promise((resolve, reject) => {
          const child = execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", CLONE_SCRIPT],
            {signal, timeout: 30000, maxBuffer: 65536}, error => error ? reject(error) : resolve());
          child.stdin.on("error", () => {});child.stdin.end(JSON.stringify(rows.slice(index)));
        });
      } catch (failure) {signal?.throwIfAborted();throw Error("This volume could not clone the application or game files.", {cause: failure});}
      signal?.throwIfAborted();return;
    }
  }
}

module.exports = { cloneFiles, prepareClones };
