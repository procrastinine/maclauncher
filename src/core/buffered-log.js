const fs = require("node:fs/promises");
const path = require("node:path");

async function trimPreviousLog(file, maximumBytes) {
  let handle;
  try {
    handle = await fs.open(file, "r+");
    const { size } = await handle.stat();
    if (size <= maximumBytes) return;
    const tail = Buffer.alloc(maximumBytes);
    const { bytesRead } = await handle.read(tail, 0, tail.length, size - tail.length);
    await handle.write(tail, 0, bytesRead, 0);
    await handle.truncate(bytesRead);
  } finally { await handle?.close(); }
}

function createBufferedLog(file, { maximumBytes = 2 * 1024 * 1024, queueBytes = 64 * 1024, delayMs = 50 } = {}) {
  let lines = [], bytes = 0, dropped = 0, timer, flushing, previousChecked = false;
  const flush = async () => {
    clearTimeout(timer); timer = undefined;
    if (flushing) { await flushing; if (lines.length || dropped) return flush(); return; }
    if (!lines.length && !dropped) return;
    const chunk = Buffer.concat(lines); lines = []; bytes = 0;
    const suppressed = dropped; dropped = 0;
    const output = suppressed ? Buffer.concat([chunk, Buffer.from(`[log] ${suppressed} messages omitted while output was busy.\n`)]) : chunk;
    flushing = (async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      let size = 0;
      try { size = (await fs.stat(file)).size; } catch {}
      if (size && size + output.length > maximumBytes) {
        try { await fs.rename(file, file + ".previous"); previousChecked = false; } catch {}
      }
      if (!previousChecked) {
        try { await trimPreviousLog(file + ".previous", maximumBytes); } catch {}
        previousChecked = true;
      }
      await fs.appendFile(file, output);
    })().catch(() => {});
    try { await flushing; } finally { flushing = undefined; }
    if (lines.length || dropped) return flush();
  };
  return {
    write(line) {
      const input = Buffer.from(line);
      const bounded = input.length <= 8192 ? input : Buffer.concat([input.subarray(0, 8188), Buffer.from("…\n")]);
      if (bytes + bounded.length > queueBytes) dropped++;
      else { lines.push(bounded); bytes += bounded.length; }
      if (!timer && !flushing) timer = setTimeout(() => { timer = undefined; void flush(); }, delayMs);
    },
    flush,
    hasPending: () => Boolean(lines.length || dropped || flushing)
  };
}

module.exports = { createBufferedLog };
