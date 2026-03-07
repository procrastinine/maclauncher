const CHILD_PROCESS_METHODS = Object.freeze([
  "exec",
  "execFile",
  "spawn",
  "fork",
  "spawnSync",
  "execSync",
  "execFileSync"
]);

function formatBlockedChildProcessMessage(method, options = {}) {
  const name = method ? `child_process.${method}` : "child_process";
  const suffix = typeof options.messageSuffix === "string" ? options.messageSuffix : "";
  return `Blocked: ${name}${suffix}`;
}

function throwBlockedChildProcess(method, options = {}) {
  const message = formatBlockedChildProcessMessage(method, options);
  if (options.alert === true) {
    try {
      if (typeof window !== "undefined" && typeof window.alert === "function") {
        window.alert(message);
      }
    } catch {}
  }
  if (options.log === true) {
    try {
      if (typeof console !== "undefined" && typeof console.error === "function") {
        console.error(message);
      }
    } catch {}
  }
  throw new Error(message);
}

function wrapChildProcessModule(childProcess, options = {}) {
  if (!childProcess || (typeof childProcess !== "object" && typeof childProcess !== "function")) {
    return childProcess;
  }

  const wrapped = Object.create(Object.getPrototypeOf(childProcess));
  const descriptors = Object.getOwnPropertyDescriptors(childProcess);

  for (const method of CHILD_PROCESS_METHODS) {
    const descriptor = descriptors[method];
    if (descriptor && typeof descriptor.value === "function") {
      descriptors[method] = {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: function blockedChildProcessMethod() {
          return throwBlockedChildProcess(method, options);
        }
      };
      continue;
    }
    if (typeof childProcess[method] === "function") {
      descriptors[method] = {
        configurable: true,
        enumerable: true,
        writable: false,
        value: function blockedChildProcessMethod() {
          return throwBlockedChildProcess(method, options);
        }
      };
    }
  }

  Object.defineProperties(wrapped, descriptors);
  return wrapped;
}

function buildDisableChildScript(options = {}) {
  const messageSuffix = typeof options.messageSuffix === "string" ? options.messageSuffix : "";
  const shouldAlert = options.alert === true;
  const shouldLog = options.log === true;
  return `// maclauncher:disable-child.js
const Module=require("module");
const METHODS=${JSON.stringify(CHILD_PROCESS_METHODS)};
const MESSAGE_SUFFIX=${JSON.stringify(messageSuffix)};
const SHOULD_ALERT=${shouldAlert ? "true" : "false"};
const SHOULD_LOG=${shouldLog ? "true" : "false"};
const orig=Module.prototype.require;
function message(method){const name=method?"child_process."+method:"child_process";return "Blocked: "+name+MESSAGE_SUFFIX}
function block(method){const msg=message(method);try{if(SHOULD_ALERT&&typeof window!=="undefined"&&typeof window.alert==="function")window.alert(msg)}catch{};try{if(SHOULD_LOG&&typeof console!=="undefined"&&typeof console.error==="function")console.error(msg)}catch{};throw new Error(msg)}
function wrap(mod){if(!mod||typeof mod!=="object"&&typeof mod!=="function")return mod;const wrapped=Object.create(Object.getPrototypeOf(mod));const descriptors=Object.getOwnPropertyDescriptors(mod);for(const method of METHODS){const descriptor=descriptors[method];if(descriptor&&typeof descriptor.value==="function"){descriptors[method]={configurable:descriptor.configurable,enumerable:descriptor.enumerable,writable:descriptor.writable,value:function blockedChildProcessMethod(){return block(method)}};continue}if(typeof mod[method]==="function"){descriptors[method]={configurable:true,enumerable:true,writable:false,value:function blockedChildProcessMethod(){return block(method)}}}}Object.defineProperties(wrapped,descriptors);return wrapped}
Module.prototype.require=function(id){const loaded=orig.apply(this,arguments);if(id==="child_process"||id==="node:child_process")return wrap(loaded);return loaded};
`;
}

module.exports = {
  CHILD_PROCESS_METHODS,
  buildDisableChildScript,
  formatBlockedChildProcessMessage,
  throwBlockedChildProcess,
  wrapChildProcessModule
};
