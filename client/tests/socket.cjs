// Test-only replacement: real hook subscriptions, with events supplied by the browser test.
exports.io = function () {
  const handlers = new Map();
  window.testSocket = (name, value) => handlers.get(name)?.(value);
  return { on: (name, fn) => handlers.set(name, fn), disconnect: () => handlers.clear() };
};
