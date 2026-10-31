// Output options that only a graphics package declaring them can read: the
// performance overlay, the explicit source frame-rate cap and the owned
// presentation options. A package without them would reject the whole output
// block, so unsupported options are removed from the published document and
// reported as pending; the saved plan keeps them.
const OPTIONS = Object.freeze([
  {id: "performance-overlay", keys: ["hud"], capability: "performanceHud", inactive: output => output.hud === "off",
    reason: "The performance overlay requires an updated graphics runtime."},
  {id: "frame-rate-cap", keys: ["frameRateCap"], capability: "frameRateCap", inactive: output => output.frameRateCap === 0,
    reason: "This game's frame source cannot apply a frame-rate cap."},
  {id: "presentation-options", keys: ["displaySync", "drawableCount"], capability: "presentationOptions", inactive: () => false,
    reason: "Display sync and drawable count require an updated graphics runtime."}]);

function supported(output, capabilities = {}, pending = []) {
  if (!output) return output;
  let result = output;
  for (const option of OPTIONS) {
    if (!option.keys.some(key => Object.hasOwn(result, key))) continue;
    const inactive = option.inactive(result);
    if (!inactive && capabilities[option.capability] === true) continue;
    if (!inactive) pending.push({id: option.id, reason: option.reason});
    result = Object.fromEntries(Object.entries(result).filter(([key]) => !option.keys.includes(key)));
  }
  return Object.keys(result).length ? result : undefined;
}

module.exports = { OPTIONS, supported };
