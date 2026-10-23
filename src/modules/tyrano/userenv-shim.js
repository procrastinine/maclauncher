// Some older Tyrano exports call $.userenv() without defining it. Supply the
// desktop fallback in the game process, preserving the author's own function.
function install(target) {
  if (!target || target.__maclauncherTyranoUserenv) return false;
  const apply = () => {
    const jquery = target.jQuery || target.$;
    if (jquery && typeof jquery.userenv !== "function") jquery.userenv = () => "pc";
  };
  apply();
  if (target.document?.addEventListener) {
    // Capture external script loads so jQuery receives the fallback before
    // the parser executes subsequent Tyrano scripts.
    target.document.addEventListener("load", apply, true);
    target.document.addEventListener("DOMContentLoaded", apply, { once: true });
  }
  Object.defineProperty(target, "__maclauncherTyranoUserenv", { value: true, configurable: true });
  return true;
}

if (typeof module === "object" && module.exports) module.exports = { install };
if (typeof window !== "undefined") install(window);
else if (typeof document !== "undefined") install(globalThis);
