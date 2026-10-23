const React = require('react');

let current;
const react = { ...React };
for (const hook of ['useState', 'useRef', 'useEffect', 'useId']) {
  react[hook] = (...args) => current ? current[hook](...args) : React[hook](...args);
}

// Exercise component event handlers and asynchronous state without a browser.
function componentHarness(Component, props) {
  const slots = [];
  let cursor = 0, effects = [];
  const hooks = {
    useId() { const index = cursor++;return (slots[index] ||= {id: `test-control-${index}`}).id; },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;
      }];
    },
    useRef(initial) {
      const index = cursor++;
      return slots[index] ||= { current: initial };
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = slots[index];
      if (!previous || !dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        slots[index] = { dependencies };
        effects.push(() => { previous?.cleanup?.();slots[index].cleanup = effect(); });
      }
    }
  };
  return {
    render() {
      cursor = 0;current = hooks;
      let tree;
      try { tree = Component(props); } finally { current = undefined; }
      const pending = effects;effects = [];for (const effect of pending) effect();
      return tree;
    },
    async settle() { await new Promise(resolve => setImmediate(resolve));return this.render(); },
    close() { for (const slot of slots) slot?.cleanup?.(); }
  };
}

module.exports = { react, componentHarness };
