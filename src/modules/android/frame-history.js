const fs = require("node:fs"), path = require("node:path");
const Writable = require("../shared/writable-input");

// Two retained descriptors form a bounded rolling history, independent of SDK
// stderr volume. The worker coalesces writes with its existing log flush.
function open(directory) {
  const files = [0, 1].map(index => path.join(directory, `frame-times.${index}.jsonl`));
  const descriptors = [];
  try {
    Writable.assertOwnDirectory(directory, directory, {create: false});
    for (const file of files) {
      Writable.atomicWrite(file, "", {root: directory});
      descriptors.push(fs.openSync(file,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW));
    }
  } catch (error) {
    for (const descriptor of descriptors) fs.closeSync(descriptor);
    throw error;
  }
  const maximum = 128 * 1024, prefix = Buffer.from("[android-frame] ");
  const remainders = new Map();
  let pending = [], pendingBytes = 0, slot = 0, size = 0, closed = false;
  return {
    files,
    feed(bytes, source) {
      if (closed) return;
      const input = Buffer.concat([remainders.get(source) || Buffer.alloc(0), bytes]);
      let remainder = Buffer.alloc(0);
      let begin = 0;
      for (;;) {
        const start = input.indexOf(prefix, begin);
        if (start < 0) {
          remainder = Buffer.from(input.subarray(Math.max(begin, input.length - prefix.length + 1)));
          break;
        }
        const end = input.indexOf(10, start);
        if (end < 0) {
          remainder = input.length - start <= 4096 ? Buffer.from(input.subarray(start)) : Buffer.alloc(0);
          break;
        }
        if (end - start <= 4096) {
          try {
            const record = JSON.parse(input.subarray(start + prefix.length, end).toString("utf8"));
            if (record && typeof record === "object" && !Array.isArray(record) &&
                (Number.isFinite(record.sourceFps) && record.sourceFps >= 0 ||
                  record.sourceFps === null && record.intervals === 0 &&
                  Number.isSafeInteger(record.observedFrames) && record.observedFrames > 0 &&
                  Number.isFinite(record.firstFrameHostSeconds) && record.firstFrameHostSeconds >= 0 &&
                  Number.isFinite(record.lastFrameHostSeconds) && record.lastFrameHostSeconds >= record.firstFrameHostSeconds) &&
                Number.isFinite(record.hostSeconds) && record.hostSeconds >= 0) {
              const line = Buffer.from(JSON.stringify({...record, recordedAt: Date.now()}) + "\n");
              pending.push(line); pendingBytes += line.length;
              while (pendingBytes > maximum) pendingBytes -= pending.shift().length;
            }
          } catch { /* An unrelated guest log line cannot interrupt execution. */ }
        }
        begin = end + 1;
      }
      remainders.set(source, remainder);
    },
    flush() {
      if (closed) return;
      for (const line of pending) {
        if (size + line.length > maximum) {slot = 1 - slot; fs.ftruncateSync(descriptors[slot], 0); size = 0;}
        for (let offset = 0; offset < line.length;) {
          const written = fs.writeSync(descriptors[slot], line, offset, line.length - offset);
          if (!written) throw new Error("Frame timing history could not be written.");
          offset += written;
        }
        size += line.length;
      }
      pending = []; pendingBytes = 0;
    },
    close() {
      if (closed) return;
      try { this.flush(); }
      finally { closed = true; remainders.clear(); pending = []; pendingBytes = 0;
        for (const descriptor of descriptors) fs.closeSync(descriptor); }
    }
  };
}
module.exports = {open};
