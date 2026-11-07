// Reads the AnyPS5 relinker's own progress lines and reports modules converted
// of the total. The main program counts as the first module; the relinker then
// prints "PRX conversion | <name> | NN% (done/total)" for the bundled modules
// and "<stage> | <name> | NN%" while it works on one of them. Output in another
// format leaves the count where it is, so the label still shows the step.
const LABEL = "Converting PS5 program…";
const MODULES = /^PRX conversion\s*\|\s*(.+?)\s*\|\s*\d{1,3}%\s*\((\d+)\/(\d+)\)/;
const STAGE = /^(Instruction conversion|Instruction scan|Syscall scan|Output image|Write output)\s*\|\s*(.+?)\s*\|\s*\d{1,3}%/;

function createConversionProgress(onProgress, { modules = 0 } = {}) {
  let total = 1 + Math.max(0, Number(modules) || 0), completed = 0, step = null, sent = null;
  const buffers = new Map();
  function report() {
    const key = JSON.stringify([completed, total, step]);
    if (key === sent) return;
    sent = key;
    onProgress?.({ phase: "prepare", label: LABEL, completed, total, unit: "modules", ...(step ? { step } : {}) });
  }
  function read(line) {
    const module = MODULES.exec(line);
    if (module) {
      const done = Number(module[2]), count = Number(module[3]);
      if (Number.isSafeInteger(done) && Number.isSafeInteger(count) && count >= done) {
        total = 1 + count;
        completed = Math.min(total, Math.max(completed, 1 + done));
      }
      return;
    }
    const stage = STAGE.exec(line);
    if (stage) { step = `${stage[1]} · ${stage[2]}`; return; }
    if (/^Conversion complete\b/.test(line)) { completed = total; step = null; }
  }
  return {
    start: report,
    // Progress lines are rewritten in place with carriage returns.
    write(text, stream = "stdout") {
      const lines = ((buffers.get(stream) || "") + String(text || "")).split(/\r\n|\r|\n/);
      buffers.set(stream, lines.pop().slice(-4096));
      for (const line of lines) read(line.trim());
      report();
    }
  };
}

module.exports = { createConversionProgress };
