function isObjectLike(value) {
  return Boolean(value) && (typeof value === "object" || typeof value === "function");
}

function ensureChromeRoot(target) {
  if (!target) return null;
  let chromeObj = target.chrome;
  if (!isObjectLike(chromeObj)) {
    const next = {};
    try {
      Object.defineProperty(target, "chrome", {
        value: next,
        configurable: true,
        writable: true
      });
      chromeObj = next;
    } catch {
      try {
        target.chrome = next;
        chromeObj = target.chrome;
      } catch {
        return null;
      }
    }
  }
  return chromeObj;
}

function ensureExtensibleChrome(target, chromeObj) {
  if (!chromeObj || typeof Object.isExtensible !== "function") return chromeObj;
  if (Object.isExtensible(chromeObj)) return chromeObj;
  const clone = Object.create(chromeObj);
  try {
    Object.defineProperty(target, "chrome", {
      value: clone,
      configurable: true,
      writable: true
    });
    return clone;
  } catch {
    try {
      target.chrome = clone;
      return target.chrome;
    } catch {
      return chromeObj;
    }
  }
}

function createWebviewShim() {
  const listeners = new Set();
  const dispatch = (data, additionalObjects = []) => {
    const event = { data, additionalObjects };
    for (const handler of listeners) {
      try {
        handler(event);
      } catch {}
    }
  };

  return {
    addEventListener(type, handler) {
      if (type !== "message" || typeof handler !== "function") return;
      listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type !== "message" || typeof handler !== "function") return;
      listeners.delete(handler);
    },
    postMessage(message) {
      let payload = message;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }
      if (!payload || typeof payload !== "object") return;
      if (payload.type === "wrapper-init") {
        dispatch({ type: "wrapper-init-response", registeredComponentIds: [] });
      }
    }
  };
}

function install(target) {
  if (!target || (typeof target !== "object" && typeof target !== "function")) return false;
  let chromeObj = ensureChromeRoot(target);
  if (!chromeObj) return false;
  chromeObj = ensureExtensibleChrome(target, chromeObj);

  if (isObjectLike(chromeObj.webview)) return true;

  const webview = createWebviewShim();
  try {
    Object.defineProperty(chromeObj, "webview", {
      value: webview,
      configurable: true,
      writable: true
    });
  } catch {
    try {
      chromeObj.webview = webview;
    } catch {
      return false;
    }
  }
  return true;
}

module.exports = {
  install
};

try {
  install(globalThis);
} catch {}
