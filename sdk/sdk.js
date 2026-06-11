/*!
 * wand-host SDK — the platform SDK injected (by reference) into a wand's
 * presentation layer. Establishes `window.wandHost`, the page-side half of the
 * postMessage RPC contract documented in spec/host-api.md.
 *
 * The page is served over loopback http in a sandboxed iframe; it is cross-origin
 * to the host app, so the host cannot inject objects directly. Instead the page
 * loads this file from the reserved `/__wandhost__/sdk.js` route and talks to the
 * host shell purely via window.parent.postMessage.
 *
 * Hard constraints (mirrors VS Code webview practice):
 *  - JSON-serializable payloads only (no Blob/File/DOM objects).
 *  - Event delivery is NOT guaranteed — treat events as idempotent hints and pull
 *    authoritative state with call('runtime.getState') when it matters.
 *  - The host is the single trust boundary: it validates origin + method + params
 *    and never exposes raw IPC / fs / network to this page.
 *
 * Zero dependencies. Loaded with a plain <script> tag.
 */
(function () {
  'use strict'
  if (window.wandHost) return

  var VERSION = '1.0.0'
  var CALL_TIMEOUT_MS = 15000

  var pending = Object.create(null) // id -> { resolve, reject, timer }
  var listeners = Object.create(null) // event -> [cb]
  var seq = 0
  var stateCache

  function uid() {
    seq += 1
    return 'wh_' + Date.now().toString(36) + '_' + seq
  }

  function post(msg) {
    msg.__wandhost = true
    // Target '*': the host validates event.origin AND event.source. We are
    // inside the host's iframe, so window.parent is the host shell.
    window.parent.postMessage(msg, '*')
  }

  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = uid()
      var timer = setTimeout(function () {
        delete pending[id]
        reject(new Error('wandHost.call timed out: ' + method))
      }, CALL_TIMEOUT_MS)
      pending[id] = { resolve: resolve, reject: reject, timer: timer }
      post({ id: id, type: 'request', method: method, params: params || {} })
    })
  }

  function on(event, cb) {
    ;(listeners[event] || (listeners[event] = [])).push(cb)
    return function off() {
      var arr = listeners[event]
      if (!arr) return
      var i = arr.indexOf(cb)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  function emit(event, payload) {
    var arr = listeners[event]
    if (!arr) return
    arr.slice().forEach(function (cb) {
      try {
        cb(payload)
      } catch (err) {
        console.error('[wandHost] listener error for "' + event + '"', err)
      }
    })
  }

  window.addEventListener('message', function (ev) {
    var d = ev.data
    if (!d || d.__wandhost !== true) return
    if (d.type === 'response') {
      var p = pending[d.id]
      if (!p) return
      clearTimeout(p.timer)
      delete pending[d.id]
      if (d.ok) p.resolve(d.result)
      else p.reject(new Error(d.error || 'wandHost error'))
    } else if (d.type === 'event') {
      if (d.event === 'theme') applyTheme(d.payload)
      emit(d.event, d.payload)
    }
  })

  // --- view-local persistence (host is source of truth; cache last value) ---
  function getState() {
    return stateCache
  }
  function setState(state) {
    stateCache = state
    call('view.setState', { state: state }).catch(function () {})
  }

  // --- theme: host pushes token map; apply as CSS vars on :root ---
  function applyTheme(tokens) {
    if (!tokens || typeof tokens !== 'object') return
    var root = document.documentElement
    Object.keys(tokens).forEach(function (k) {
      // Accept either "--wv-bg" or "bg" keys; normalize to --wv-*.
      var name = k.indexOf('--') === 0 ? k : '--wv-' + k
      root.style.setProperty(name, String(tokens[k]))
    })
  }

  var wandHost = {
    version: VERSION,
    call: call,
    on: on,
    getState: getState,
    setState: setState,
    applyTheme: applyTheme,
    info: null,
    get: function () {
      return call('wand.get')
    },
    getPhase: function (phaseId) {
      return call('phase.get', { phaseId: phaseId })
    },
    openPhaseDrawer: function (phaseId) {
      return call('ui.openPhaseDrawer', { phaseId: phaseId })
    },
    openDrawer: function (title, markdown) {
      return call('ui.openDrawer', { title: title, markdown: markdown })
    },
    getRuntimeState: function () {
      return call('runtime.getState')
    },
    // Runtime-view convenience wrappers (host rejects them in static mode).
    listFiles: function () {
      return call('runtime.listFiles')
    },
    readFile: function (path) {
      return call('runtime.readFile', { path: path })
    },
    registerNav: function (spec) {
      return call('nav.register', spec)
    },
    updateNav: function (current) {
      return call('nav.update', { current: current })
    },
    registerActions: function (actions) {
      return call('actions.register', { actions: actions })
    },
    toast: function (level, message) {
      return call('ui.toast', { level: level, message: message })
    },
    setStatus: function (state, message) {
      return call('ui.setStatus', { state: state, message: message })
    }
  }

  // Handshake: announce readiness; host replies with { apiVersion, mode, appId,
  // theme, state }. Pages can await `wandHost.ready`.
  wandHost.ready = call('host.ready', { sdkVersion: VERSION })
    .then(function (info) {
      wandHost.info = info || null
      if (info && info.state !== undefined) stateCache = info.state
      if (info && info.theme) applyTheme(info.theme)
      return info
    })
    .catch(function (err) {
      console.error('[wandHost] handshake failed', err)
      return null
    })

  window.wandHost = wandHost
})()
