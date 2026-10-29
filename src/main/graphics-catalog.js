// The launcher's graphics catalog (ReShade.getState: shader library,
// collections, models and processor capabilities) follows editor demand. A
// renderer view declares demand while it is open and releases it when it
// closes; without demand nothing is built or sent.
//
// The inventory revision keys every reuse, here and in editor discovery
// (EffectsRuntime.info). It changes with its inputs (runtime and model
// inventories, graphics settings, hardware), with explicit inventory changes
// such as filter imports, and when an opening view finds a shader source
// edited in place: each view's first request builds the catalog again and
// compares it, because only a fresh read observes source file identities.
const crypto = require("node:crypto");
const CHANNEL = "launcher:graphicsCatalog";

function createGraphicsCatalog({build, inputs, logger}) {
  // webContents id → {sender, count}
  const viewers = new Map();
  let epoch = 0, built = null, published = 0;
  const revision = () => `${epoch}:${inputs()}`;
  function read({revalidate = false} = {}) {
    const key = revision();
    if (built?.key === key && !revalidate) return built;
    const value = build(), digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (built?.digest === digest) {built = {...built, key};return built;}
    // The same inputs with a different result: a source changed in place.
    if (built?.key === key) epoch++;
    built = {key: revision(), value, digest, published: ++published};
    return built;
  }
  function send(sender, value) {
    try {if (!sender.isDestroyed()) sender.send(CHANNEL, {revision: value.published, reshade: value.value});}
    catch (error) {logger?.warn?.("[graphics] The graphics catalog could not be sent.", error.message);}
  }
  function publish(options, except) {
    if (!viewers.size) return built;
    const before = built?.published, next = read(options);
    if (next.published !== before) for (const {sender} of viewers.values()) if (sender !== except) send(sender, next);
    return next;
  }
  function release(sender) {
    const viewer = viewers.get(sender.id);
    if (viewer && --viewer.count <= 0) viewers.delete(sender.id);
  }
  return {
    CHANNEL,
    // The revision for reuse keys; reading it builds nothing.
    revision,
    // {open, revision}: a view opened (or closed). Returns the published
    // revision, with the catalog when the view does not hold that revision.
    request(sender, {open, revision: known} = {}) {
      if (!open) {release(sender);return {revision: built?.published ?? null};}
      const viewer = viewers.get(sender.id);
      if (viewer) viewer.count++;
      else {
        viewers.set(sender.id, {sender, count: 1});
        sender.once?.("destroyed", () => viewers.delete(sender.id));
      }
      const current = publish({revalidate: !viewer}, sender);
      return current.published === known ? {revision: current.published} : {revision: current.published, reshade: current.value};
    },
    // An inventory change the inputs do not show (filter library edits).
    changed() {epoch++;publish();},
    // The inputs may have changed; only open views cause a build.
    refresh() {publish();},
    get demanded() {return viewers.size > 0;}
  };
}
module.exports = {createGraphicsCatalog, CHANNEL};
