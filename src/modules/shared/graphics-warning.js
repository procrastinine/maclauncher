// Graphics observation is optional; a notification sink cannot veto preparation,
// independent-stage recovery or restoration of the original renderer.
function observeGraphics(logger, level, messages) {
  try {
    const notification = logger?.[level]?.(...messages);
    if (notification && typeof notification.then === "function") Promise.resolve(notification).catch(() => {});
  } catch {}
}
module.exports = function warnGraphics(logger, ...messages) {
  observeGraphics(logger, "warn", messages);
};
module.exports.info = function infoGraphics(logger, ...messages) {
  observeGraphics(logger, "info", messages);
};
