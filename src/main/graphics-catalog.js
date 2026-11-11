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
  // webContents id → {sender, count, revision}
  const viewers = new Map();
  let epoch = 0, built = null, published = 0, queue = Promise.resolve();
  const revision = () => `${epoch}:${inputs()}`;
  // Builds run one at a time. The build itself runs in a backend worker, so
  // this process only compares and sends its result.
  function read(options) {
    const next = queue.then(() => readNow(options));
    queue = next.catch(() => {});
    return next;
  }
  async function readNow({revalidate = false} = {}) {
    const current = inputs(), key = `${epoch}:${current}`;
    if (built?.key === key && !revalidate) return built;
    const value = await build(), digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
    if (built?.digest === digest) {built = {...built, key};return built;}
    // The same inputs with a different result: a source changed in place.
    if (built?.key === key) epoch++;
    built = {key: `${epoch}:${current}`, value, digest, published: ++published};
    return built;
  }
  function send(viewer, value) {
    viewer.revision = value.published;
    try {if (!viewer.sender.isDestroyed()) viewer.sender.send(CHANNEL, {revision: value.published, reshade: value.value});}
    catch (error) {logger?.warn?.("[graphics] The graphics catalog could not be sent.", error.message);}
  }
  async function publish(options, except) {
    if (!viewers.size) return built;
    const next = await read(options);
    for (const viewer of viewers.values()) if (viewer.sender !== except && viewer.revision !== next.published) send(viewer, next);
    return next;
  }
  const latest = () => built?.published ?? null;
  function release(sender) {
    const viewer = viewers.get(sender.id);
    if (viewer && --viewer.count <= 0) viewers.delete(sender.id);
  }
  const background = options => publish(options).catch(error => logger?.warn?.("[graphics] The graphics catalog could not be read.", error.message));
  return {
    CHANNEL,
    // The revision for reuse keys; reading it builds nothing.
    revision,
    // {open, revision}: a view opened (or closed). Resolves to the published
    // revision, with the catalog when the view does not hold that revision.
    async request(sender, {open, revision: known} = {}) {
      if (!open) {release(sender);return {revision: latest()};}
      let viewer = viewers.get(sender.id);
      const opening = !viewer;
      if (viewer) viewer.count++;
      else {
        viewer = {sender, count: 1, revision: known ?? null};
        viewers.set(sender.id, viewer);
        sender.once?.("destroyed", () => viewers.delete(sender.id));
      }
      const current = await publish({revalidate: opening}, sender);
      viewer.revision = current.published;
      return current.published === known ? {revision: current.published} : {revision: current.published, reshade: current.value};
    },
    // An inventory change the inputs do not show (filter library edits).
    changed() {epoch++;return background();},
    // The inputs may have changed; only open views cause a build.
    refresh() {return background();},
    get demanded() {return viewers.size > 0;}
  };
}
module.exports = {createGraphicsCatalog, CHANNEL};
