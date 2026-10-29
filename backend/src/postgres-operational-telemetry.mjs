import { errorMonitor } from 'node:events';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { operationalTelemetry } from './operational-telemetry.mjs';

const pools = new WeakSet();
const clients = new WeakSet();

function completion(type) {
  const startedAt = performance.now();
  let completed = false;
  return error => {
    if (completed) return;
    completed = true;
    try {
      operationalTelemetry(type, { dependency: 'postgresql', outcome: error ? 'failure' : 'success', durationMs: Math.max(0, performance.now() - startedAt) });
    } catch { /* Observation cannot change driver or callback outcomes. */ }
  };
}

// Plain data configs can be wrapped while preserving own keys, descriptors,
// prototype and driver writes. A fully frozen config needs a descriptor-identical
// shadow because Proxy invariants forbid replacing its callback read. Exotic
// configs keep their original identity and semantics; they are simply not timed.
function callbackConfig(config, callback, wrapped) {
  if (!config || typeof config !== 'object' || types.isProxy(config)) return null;
  const prototype = Object.getPrototypeOf(config);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(config);
  const descriptor = descriptors.callback;
  if (!descriptor || !('value' in descriptor) || descriptor.value !== callback ||
      Reflect.ownKeys(descriptors).some(key => !('value' in descriptors[key]))) return null;
  if (descriptor.configurable || descriptor.writable) return new Proxy(config, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return key === 'callback' && value === callback ? wrapped : value;
    },
    set(target, key, value) { return Reflect.set(target, key, value, target); },
  });
  if (!Object.isFrozen(config)) return null;
  descriptors.callback = { ...descriptor, value: wrapped };
  return Object.preventExtensions(Object.create(prototype, descriptors));
}

function instrumentClient(client) {
  if (!client || clients.has(client) || typeof client.query !== 'function') return client;
  const query = client.query;
  client.query = function (...args) {
    const finish = completion('db-query');
    const config = args[0];
    const submittable = config && typeof config.submit === 'function';
    // Client.query(Query) returns the original Query, not a promise. Do not
    // add an 'error' listener: that would swallow otherwise unhandled errors.
    let callback = submittable && typeof config.callback === 'function' ? config.callback : null;
    let callbackIndex = -1;
    if (!callback) {
      if (!submittable && typeof args[2] === 'function') callbackIndex = 2;
      else if (typeof args[1] === 'function') callbackIndex = 1;
      if (callbackIndex >= 0) callback = args[callbackIndex];
      else if (!submittable && typeof config?.callback === 'function') callback = config.callback;
    }
    let wrapped;
    let cleanup = () => {};
    if (callback) {
      wrapped = function (...values) {
        finish(values[0]);
        if (submittable && config.callback === wrapped) config.callback = callback;
        return Reflect.apply(callback, this, values);
      };
      if (callbackIndex >= 0) args[callbackIndex] = wrapped;
      else if (submittable) {
        // Query objects need to retain identity. Frozen/accessor/custom Proxy
        // callbacks cannot be temporarily wrapped without changing behavior.
        if (types.isProxy(config)) return Reflect.apply(query, this, args);
        const descriptor = Object.getOwnPropertyDescriptor(config, 'callback');
        if (!descriptor || !('value' in descriptor) || !descriptor.writable) return Reflect.apply(query, this, args);
        config.callback = wrapped;
      } else {
        // pg will assign an explicit values argument to the caller's config.
        // Do not copy in that case: changing that write breaks its API. Likewise
        // leave exotic configs untouched if they cannot be shadowed safely.
        if (args[1]) return Reflect.apply(query, this, args);
        let shadow;
        try { shadow = callbackConfig(config, callback, wrapped); } catch { /* Observation is optional. */ }
        if (!shadow) return Reflect.apply(query, this, args);
        args[0] = shadow;
      }
    } else if (submittable && typeof config.once === 'function') {
      const end = () => { cleanup(); finish(null); };
      const error = value => { cleanup(); finish(value); };
      cleanup = () => { config.removeListener('end', end); config.removeListener(errorMonitor, error); };
      config.once('end', end);
      config.once(errorMonitor, error);
    }
    try {
      const value = Reflect.apply(query, this, args);
      if (!callback && !submittable && typeof value?.then === 'function') {
        return value.then(result => { finish(null); return result; }, error => { finish(error); throw error; });
      }
      return value;
    } catch (error) {
      cleanup();
      finish(error);
      if (submittable && config.callback === wrapped) config.callback = callback;
      throw error;
    } finally {
      // pg copies normal config callbacks into its Query and may also assign
      // explicit callback arguments back to config. Preserve that public state.
      if (!submittable && wrapped && config && typeof config === 'object' && config.callback === wrapped) config.callback = callback;
    }
  };
  clients.add(client);
  return client;
}

/** Instrument only foundation-owned pools. Keep client/release identity intact. */
export function instrumentPostgresPool(pool) {
  if (!pool || pools.has(pool) || typeof pool.connect !== 'function') return pool;
  const connect = pool.connect;
  pool.connect = function (...args) {
    const finish = completion('db-pool-wait');
    const prepare = client => {
      try { instrumentClient(client); } catch { /* Frozen/custom clients remain usable. */ }
      return client;
    };
    if (typeof args[0] === 'function') {
      const callback = args[0];
      args[0] = function (error, client, ...rest) {
        finish(error);
        return Reflect.apply(callback, this, [error, error ? client : prepare(client), ...rest]);
      };
    }
    try {
      const value = Reflect.apply(connect, this, args);
      if (typeof args[0] !== 'function' && typeof value?.then === 'function') {
        return value.then(client => { finish(null); return prepare(client); }, error => { finish(error); throw error; });
      }
      return value;
    } catch (error) { finish(error); throw error; }
  };
  pools.add(pool);
  // Do not wrap pool.query: pg-pool delegates through connect and client.query.
  // Timing both layers would count every ordinary query twice and include pool
  // queue time in query latency. Checkout and statement latency stay separate.
  return pool;
}
