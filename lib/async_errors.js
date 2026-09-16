'use strict';
// Route handlers written as `async (req, res) => {...}` return a promise.
// Express 4 ignores that promise, so an error thrown inside one (a bad value in
// a request body, a failed query) became an unhandled rejection, and Node
// stopped the whole server. Railway restarted it, but everyone was kicked out.
//
// Required once, at the top of server.js, before any route is registered. It
// wraps every handler Express stores so a rejected promise is passed to next(),
// which sends it to the normal error handler at the bottom of server.js: the
// one request gets an error response and the server keeps running.
// This is the same approach as the express-async-errors package.
const Layer = require('express/lib/router/layer');

function wrap(fn) {
  if (typeof fn !== 'function') return fn;
  const wrapped = function (...args) {
    const ret = fn.apply(this, args);
    if (ret && typeof ret.catch === 'function') {
      const next = args[args.length - 1];
      ret.catch(err => (typeof next === 'function' ? next(err) : console.error('[async] unhandled route error:', err)));
    }
    return ret;
  };
  // Express tells error handlers (4 arguments) from normal ones by length.
  Object.defineProperty(wrapped, 'length', { value: fn.length });
  return wrapped;
}

if (!Layer.prototype.__asyncErrorsPatched) {
  Object.defineProperty(Layer.prototype, 'handle', {
    enumerable: true,
    configurable: true,
    get() { return this.__handle; },
    set(fn) { this.__handle = wrap(fn); },
  });
  Layer.prototype.__asyncErrorsPatched = true;
}

module.exports = {};
