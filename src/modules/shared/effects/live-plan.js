const Plan = require("./plan");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const Writable = require("../writable-input");
const Providers = require("./providers");
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024, MAX_HISTORY = 4, MAX_HISTORY_BYTES = MAX_DOCUMENT_BYTES * MAX_HISTORY + 8192;
function selectionKey(node) {
  // A request key identifies one row alone. Helper ownership names another
  // row, so it stays outside this single-row validation.
  const {ownedBy, ...row} = node;
  const normalized = Plan.validate({schema: 2, enabled: true, mode: "advanced", video: [row]}).video[0];
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
function validDocument(value) {
  return value?.schema === 1 && ["simple", "advanced"].includes(value.mode) && Array.isArray(value.nodes) &&
    value.nodes.length <= Plan.MAX_NODES && (value.mode !== "simple" || value.nodes.length === 0) && /^[a-f0-9]{64}$/.test(value.revision || "") &&
    value.revision === crypto.createHash("sha256").update(JSON.stringify(value.mode === "simple" ? ["simple"] :
      value.output ? {nodes: value.nodes, output: value.output} : value.nodes)).digest("hex");
}

function readDocument(file, publication) {
  try {
    let bytes;
    if (publication) bytes = publication.readOriginal(file, "utf8");
    else {
      const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size < 1 || stat.size > 4 * 1024 * 1024) return null;
        bytes = fs.readFileSync(descriptor, "utf8");
      } finally {fs.closeSync(descriptor);}
    }
    if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) return null;
    const value = JSON.parse(bytes);return validDocument(value) ? value : null;
  } catch {return null;}
}

const historyFile = file => path.join(path.dirname(file), "effect-plan-history.json");
function readHistory(file, launchId, publication) {
  try {
    let bytes;
    if (publication) bytes = publication.readOriginal(historyFile(file), "utf8");
    else {
      const descriptor = fs.openSync(historyFile(file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(descriptor);
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_HISTORY_BYTES) return [];
        bytes = fs.readFileSync(descriptor, "utf8");
      } finally {fs.closeSync(descriptor);}
    }
    if (Buffer.byteLength(bytes) > MAX_HISTORY_BYTES) return [];
    const value = JSON.parse(bytes);
    return value?.schema === 1 && value.launchId === launchId && Array.isArray(value.documents) && value.documents.length <= MAX_HISTORY
      ? value.documents : [];
  } catch {return [];}
}
function readAcceptedDocument(file, {launchId, revision, publication} = {}) {
  if (!/^[\w-]{1,128}$/.test(launchId || "") || !/^[a-f0-9]{64}$/.test(revision || "")) return null;
  const current = readDocument(file, publication);
  if (current?.revision === revision) return current;
  const previous = readHistory(file, launchId, publication).find(row => row?.revision === revision);
  return validDocument(previous) ? previous : null;
}
// Keep a small history of immutable native documents, so a rejected publication
// cannot replace the row used for an independent live edit. Only a revision
// explicitly acknowledged by the native resource owner may be selected from it.
function recordDocument(file, document, {launchId, acceptedRevision, publication, root} = {}) {
  if (!/^[\w-]{1,128}$/.test(launchId || "") || !validDocument(document)) return false;
  const previous = readDocument(file, publication), rows = readHistory(file, launchId, publication);
  const documents = [...new Map([document, previous, ...rows].filter(validDocument).map(row => [row.revision, row])).values()];
  const accepted = documents.find(row => row.revision === acceptedRevision);
  const retained = documents.slice(0, MAX_HISTORY);
  if (accepted && !retained.includes(accepted)) retained[retained.length - 1] = accepted;
  const bytes = JSON.stringify({schema: 1, launchId, documents: retained});
  if (Buffer.byteLength(bytes) > MAX_HISTORY_BYTES) return false;
  if (publication) publication.write(historyFile(file), bytes, {root});
  else Writable.atomicWrite(historyFile(file), bytes, {root});
  return true;
}

// A resource unavailable to this process must not defer unrelated edits. The
// previous native row is immutable and is reused verbatim; it is not prepared
// again from a future model choice. Ordered geometry is validated by the caller.
function project(requested, previous, unavailable) {
  const plan = Plan.validate(requested), retained = new Map(), pending = [];
  if (!validDocument(previous)) return null;
  let available = 0;
  for (let index = 0; index < plan.video.length; index++) {
    const node = plan.video[index];
    if (!node.enabled) continue;
    const reason = unavailable(node);
    if (!reason) {available++;continue;}
    const family = node.kind === "frame-generation" ? "frame-generation" : Providers.neural(node) ? "neural" : Plan.isResize(node) ? "spatial" : node.kind;
    const old = previous.nodes.find(row => row.id === node.id && row.kind === family && row.enabled === true);
    let replacement;
    if (old && node.kind !== "shader") try {
      const settings = {...old.settings};
      const kind = Providers.descriptor(old.method)?.kind || (old.resizeDirection === "downsample" || old.resizeDirection === "upscale" ? old.resizeDirection : node.kind);
      replacement = Plan.validate({schema: 2, enabled: true, mode: "advanced", video: [{id: node.id, kind, enabled: true,
        method: old.method, settings, ...(old.outputSize ? {outputSize: old.outputSize} : {}),
        ...(old.presentationScale !== undefined ? {presentationScale: old.presentationScale} : {})}]}).video[0];
    } catch {}
    pending.push({id: node.id, kind: node.kind, method: node.method, reason, retained: Boolean(replacement), requestKey: selectionKey(node)});
    if (replacement) {
      plan.video[index] = replacement;retained.set(node.id, structuredClone(old));
    } else node.enabled = false;
  }
  // With no independently usable enabled stage, preserve the original complete
  // graph and its existing deferred behavior instead of publishing a no-op.
  return pending.length && available ? {plan, retained, pending} : null;
}

module.exports = {project, readDocument, readAcceptedDocument, recordDocument, selectionKey, validDocument};
