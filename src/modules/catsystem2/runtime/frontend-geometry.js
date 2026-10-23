const Encoding = require("../encoding");

const PROFILE = "CatSystem2-image-layout-2.6.1.76";
const LIMITS = Object.freeze({ fileBytes: 126, dimension: 16384, pixels: 16 * 1024 * 1024 });

/** Resolve the original image-reference geometry without choosing a frame. */
async function imageGeometry(source, { engineVersion, machine, describeFrame } = {}) {
  if (engineVersion !== "2.6.1.76" || typeof source !== "string" || typeof describeFrame !== "function" || !machine?.string || !machine?.value)
    throw new Error("This FES image-layout profile or service is unsupported.");
  const colon = source.indexOf(":"), nameSource = colon < 0 ? source : source.slice(0, colon), idSource = colon < 0 ? "0" : source.slice(colon + 1);
  if (!nameSource || !idSource || idSource.includes(":")) throw new Error("FES image geometry needs one file and frame ID.");
  const name = machine.string(nameSource), id = machine.value(idSource);
  if (!name || Encoding.encode(name).length > LIMITS.fileBytes || /[\0\r\n:]/.test(name) || !Number.isInteger(id) || id < 0)
    throw new Error("FES image geometry exceeds its reference limit.");
  const frame = await describeFrame(name, id, { allowMissing: true });
  // Native SIZE2/POS2 queries initialize both outputs to zero and keep them
  // zero for an absent file/ID. Ambiguous or corrupt data remains an error.
  if (frame === null) return Object.freeze({ profile: PROFILE, name, frameId: id, width: 0, height: 0, x: 0, y: 0, available: false });
  if (!frame || frame.frameId !== id || ![frame.width, frame.height].every(value => Number.isInteger(value) && value > 0 && value <= LIMITS.dimension) ||
      frame.width * frame.height > LIMITS.pixels || ![frame.offsetX, frame.offsetY].every(value => Number.isInteger(value) && Math.abs(value) <= LIMITS.dimension))
    throw new Error("FES referenced image geometry is invalid.");
  return Object.freeze({ profile: PROFILE, name, frameId: id, width: frame.width, height: frame.height, x: frame.offsetX, y: frame.offsetY, available: true });
}

module.exports = { PROFILE, LIMITS, imageGeometry };
