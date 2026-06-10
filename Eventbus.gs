// ============================================================
// EventBus.gs — Platform event dispatcher
// ============================================================
// A synchronous, code-side event bus. Modules announce that
// something happened by calling EventBus.emit(name, data); any
// listeners registered for that event run in sequence within the
// SAME dispatch execution. The emitting module never knows who is
// listening — this is the loose-coupling seam that lets new modules
// react to existing events without modifying the emitter.
//
// WHY CODE-SIDE (not a Sheet registry): listener lookup is a plain
// object read (effectively free), where a Sheet-backed registry would
// add a sheet read to every emit(). In Apps Script, sheet I/O is the
// dominant latency cost, so the registry lives in code.
//
// WHERE LISTENERS ARE REGISTERED: getEventListeners() in Code.gs —
// an append-only map mirroring getRegisteredHandlers(). New modules
// add their subscriptions there and nowhere else. EventBus reads that
// map lazily on the first emit() (NOT at file-load time), so there is
// no dependence on .gs file evaluation order.
//
// FAILURE CONTRACT: a listener that throws is caught, logged, and
// recorded as one audit entry — then the bus continues to the next
// listener. A broken listener can never break the action that emitted
// the event. (Same principle as AuditLog swallowing its own errors.)
// ============================================================

const EventBus = (() => {

  // Execution-scoped cache: build the listener map at most once per
  // request, mirroring the _moduleRegistryCache pattern in Config.gs.
  let _listenerCache = null;


  /**
   * Returns the listener map { eventName: [{ name, fn }, ...] },
   * built once per execution from getEventListeners() in Code.gs.
   * Tolerates a missing or malformed registry by returning {}.
   */
  function _listeners() {
    if (_listenerCache) return _listenerCache;
    let map = {};
    try {
      if (typeof getEventListeners === 'function') {
        const raw = getEventListeners() || {};
        // Normalize: each event maps to an array of { name, fn }.
        Object.keys(raw).forEach(eventName => {
          const entries = Array.isArray(raw[eventName]) ? raw[eventName] : [raw[eventName]];
          map[eventName] = entries
            .filter(e => e && typeof e.fn === 'function')
            .map(e => ({ name: String(e.name || e.fn.name || 'anonymous'), fn: e.fn }));
        });
      }
    } catch (err) {
      Logger.log('EventBus: failed to build listener map: ' + err);
      map = {};
    }
    _listenerCache = map;
    return _listenerCache;
  }


  /**
   * Announces that an event occurred. Runs every listener registered
   * for `name` synchronously, in registration order, isolating each
   * one's failures. Returns a summary; never throws on listener error.
   *
   * @param {string} name    - event key, e.g. 'thesis.submitted'
   * @param {Object} data    - event payload (module-defined shape)
   * @param {Object} context - { user } and any other ambient info;
   *                            passed to listeners explicitly so they
   *                            need not rely on Session state.
   * @returns {{ event: string, listenersRun: number, listenersFailed: number }}
   */
  function emit(name, data, context) {
    const eventName = String(name || '').trim();
    if (!eventName) {
      Logger.log('EventBus.emit called with empty event name; ignoring.');
      return { event: '', listenersRun: 0, listenersFailed: 0 };
    }

    const ctx = context || {};
    const listeners = _listeners()[eventName] || [];
    let run = 0;
    let failed = 0;

    listeners.forEach(listener => {
      try {
        listener.fn(data, eventName, ctx);
        run++;
      } catch (err) {
        failed++;
        Logger.log('EventBus listener "' + listener.name + '" failed on "' + eventName + '": ' + err);
        // Record the failure so it is visible, without breaking the emitter.
        AuditLog.write({
          user:   ctx.user || '',
          module: 'eventbus',
          action: eventName,
          status: 'error',
          notes:  'listener "' + listener.name + '" threw: ' + (err && err.message ? err.message : err),
        });
      }
    });

    return { event: eventName, listenersRun: run, listenersFailed: failed };
  }


  /**
   * Returns the event names that currently have at least one listener.
   * Useful for an admin/diagnostic view of what the platform reacts to.
   */
  function registeredEvents() {
    const map = _listeners();
    return Object.keys(map).filter(k => map[k] && map[k].length);
  }


  /** Clears the execution-scoped listener cache (test/diagnostic use). */
  function clearCache() {
    _listenerCache = null;
  }


  return { emit, registeredEvents, clearCache };

})();