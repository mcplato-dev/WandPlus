/*!
 * wand-host viz — the shared visualization toolkit for wand presentation layers.
 *
 * Renders a WandDetail (fetched via window.wandHost.get) on an infinite, pannable
 * & zoomable canvas. Three built-in modes:
 *   - mindmap : a radial map of the WHOLE wand (center → phases + Outputs /
 *               Capabilities / Identity / Global rules, each fanning out leaves).
 *   - flow    : a sequential node chain of the phases.
 *   - cards   : a plain responsive grid (no canvas).
 *
 * Shared infrastructure provided to every wand view (wands plug in, they
 * don't reimplement):
 *   - Infinite canvas: drag to pan, scroll to zoom, +/−/fit controls.
 *   - Occlusion: every node has an opaque backing, so edges never bleed through.
 *   - Animation: nodes fade in (staggered), structural edges "draw in", and the
 *     phase→phase flow is a continuously flowing dashed arrow.
 *   - Theme-driven (var(--wv-*)); a theme push re-colours everything live.
 *
 * Clicking a phase defers detail to the native drawer via
 * wandHost.openPhaseDrawer(id) — progressive disclosure, no big content in-view.
 *
 * Auto-mount: any element with a `data-wv-mode` attribute is mounted on load, so
 * templates need no inline <script> (keeps a strict CSP: script-src 'self').
 *
 *   <div id="app" class="wv-root" data-wv-mode="mindmap"></div>
 *
 * Advanced views can drive the canvas directly: wandViz.canvas(hostEl).
 * Zero dependencies, pure SVG.
 */
(function () {
  'use strict'
  var NS = 'http://www.w3.org/2000/svg'
  // Concrete family for canvas text measurement (ctx.font can't resolve var()).
  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif'
  var CARD_W = 264
  var CARD_H = 92
  // Mindmap rings (virtual units; the canvas fits/scales them to the panel).
  var R1 = 300
  var R2A = 540
  var R2B = 640

  // ---- tiny helpers --------------------------------------------------------
  function el(sel) {
    return typeof sel === 'string' ? document.querySelector(sel) : sel
  }
  function svg(tag, attrs) {
    var e = document.createElementNS(NS, tag)
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k]
        if (v !== null && v !== undefined) e.setAttribute(k, v)
      }
    }
    return e
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
  }
  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v))
  }
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  }
  function truncate(s, n) {
    s = String(s)
    return s.length > n ? s.slice(0, n - 1).trim() + '…' : s
  }
  function titleCase(s) {
    return s.replace(/\b\w/g, function (c) {
      return c.toUpperCase()
    })
  }
  var measureCtx = null
  function measure(text, weight, size) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')
    measureCtx.font = weight + ' ' + size + 'px ' + FONT
    return measureCtx.measureText(String(text)).width
  }
  function gateChip(p) {
    return p.gate && p.gate.mode === 'prompt' ? 'judge gate' : 'script gate'
  }
  function gateLabel(g) {
    return g && g.mode === 'prompt' ? 'judge gate' : 'script gate'
  }

  // ---- component CSS (viz owns its DOM/styles; theme.css owns the tokens) ---
  var COMPONENT_CSS =
    // foreignObject cards (flow / cards grid)
    '.wv-card{box-sizing:border-box;width:100%;min-height:100%;display:flex;flex-direction:column;gap:6px;' +
    'padding:10px 12px;background:var(--wv-bg-elevated);border:1px solid var(--wv-border);' +
    'border-radius:var(--wv-radius);cursor:pointer;transition:border-color .12s,box-shadow .12s;overflow:hidden}' +
    '.wv-card:hover,.wv-card:focus-visible{border-color:var(--wv-accent);box-shadow:0 0 0 2px var(--wv-accent-soft);outline:none}' +
    '.wv-card-head{display:flex;align-items:center;gap:8px}' +
    '.wv-order{flex:0 0 auto;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
    'font-size:11px;font-weight:600;background:var(--wv-accent-soft);color:var(--wv-accent)}' +
    '.wv-title{font-weight:600;font-size:13px;line-height:1.25;color:var(--wv-text);overflow:hidden;' +
    'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}' +
    '.wv-initial{margin-left:auto;font-size:10px;color:var(--wv-accent);white-space:nowrap}' +
    '.wv-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto}' +
    '.wv-chip{font-size:10px;color:var(--wv-text-dim);background:var(--wv-bg-hover);border:1px solid var(--wv-border);' +
    'border-radius:6px;padding:1px 6px;white-space:nowrap}' +
    '.wv-center .wv-card{background:var(--wv-accent-soft);border-color:var(--wv-accent)}' +
    '.wv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:22px}' +
    '.wv-grid .wv-card{min-height:84px}' +
    // infinite canvas
    '.wv-canvas{position:absolute;inset:0;overflow:hidden}' +
    '.wv-svg{width:100%;height:100%;display:block;cursor:grab;touch-action:none}' +
    '.wv-svg.wv-grabbing{cursor:grabbing}' +
    '.wv-tools{position:absolute;right:12px;bottom:12px;display:flex;flex-direction:column;gap:6px;z-index:3}' +
    '.wv-btn{width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:8px;' +
    'border:1px solid var(--wv-border);background:var(--wv-bg-elevated);color:var(--wv-text-dim);cursor:pointer;' +
    'font-size:16px;line-height:1;padding:0;user-select:none}' +
    '.wv-btn:hover{color:var(--wv-text);border-color:var(--wv-accent)}' +
    // edges
    '.wv-link,.wv-leaflink,.wv-flow{fill:none}' +
    '.wv-link{stroke:var(--wv-edge);stroke-width:1.4}' +
    '.wv-link--phase{stroke:var(--wv-accent);stroke-width:1.8;opacity:.5}' +
    '.wv-leaflink{stroke:var(--wv-border-strong);stroke-width:1;opacity:.6}' +
    '.wv-draw{stroke-dasharray:1;stroke-dashoffset:1;animation:wv-draw .55s ease forwards}' +
    '@keyframes wv-draw{to{stroke-dashoffset:0}}' +
    '.wv-flow{stroke:var(--wv-accent);stroke-width:2;stroke-dasharray:5 7;marker-end:url(#wv-arrow);' +
    'animation:wv-flow 900ms linear infinite}' +
    '@keyframes wv-flow{to{stroke-dashoffset:-12}}' +
    // mindmap svg nodes
    '.wv-mnode{animation:wv-pop .42s ease both}' +
    '@keyframes wv-pop{from{opacity:0}to{opacity:1}}' +
    '.wv-mnode text{dominant-baseline:middle;font-family:var(--wv-font);pointer-events:none}' +
    '.wv-mbg{fill:var(--wv-bg)}' +
    '.wv-mface{transition:stroke .12s ease}' +
    '.wv-m-center .wv-mface{fill:var(--wv-accent-soft);stroke:var(--wv-accent);stroke-width:1.5}' +
    '.wv-m-center .wv-mtitle{fill:var(--wv-text);font-weight:700;font-size:16px}' +
    '.wv-m-center .wv-msub{fill:var(--wv-text-dim);font-size:11.5px}' +
    '.wv-m-branch .wv-mface{fill:var(--wv-bg-elevated);stroke:var(--wv-border);stroke-width:1.25}' +
    '.wv-m-branch .wv-mtitle{fill:var(--wv-text);font-weight:600;font-size:13.5px}' +
    '.wv-m-branch .wv-msub{fill:var(--wv-text-dim);font-size:10.5px}' +
    '.wv-m-branch--phase .wv-mface{stroke:var(--wv-accent)}' +
    '.wv-m-leaf .wv-mface{fill:var(--wv-bg-hover);stroke:var(--wv-border);stroke-width:1}' +
    '.wv-m-leaf .wv-mtitle{fill:var(--wv-text-dim);font-weight:500;font-size:11.5px}' +
    '.wv-mclick{cursor:pointer}' +
    '.wv-mclick:hover .wv-mface,.wv-mclick:focus-visible .wv-mface{stroke:var(--wv-accent);stroke-width:2}' +
    '.wv-mclick:hover{filter:drop-shadow(0 2px 7px rgba(0,0,0,.4))}' +
    '.wv-mclick:focus-visible{outline:none}' +
    // runtime HUD (floating current-phase chip, §5.4)
    '.wv-hud{position:fixed;right:14px;bottom:14px;z-index:50;display:flex;align-items:center;gap:8px;' +
    'padding:6px 12px;border-radius:999px;background:var(--wv-bg-elevated);border:1px solid var(--wv-border);' +
    'color:var(--wv-text-dim);font:12px var(--wv-font);box-shadow:0 4px 16px rgba(0,0,0,.25);user-select:none}' +
    '.wv-hud-dot{width:7px;height:7px;border-radius:50%;background:var(--wv-accent);flex:none}' +
    '.wv-hud--pulse .wv-hud-dot{animation:wv-hudpulse .9s ease-in-out infinite}' +
    '.wv-hud--done .wv-hud-dot{background:#23d18b}' +
    '@keyframes wv-hudpulse{0%,100%{opacity:1}50%{opacity:.3}}'

  function injectCss() {
    if (document.getElementById('wv-component-css')) return
    var s = document.createElement('style')
    s.id = 'wv-component-css'
    s.textContent = COMPONENT_CSS
    document.head.appendChild(s)
  }

  // ---- foreignObject cards (flow / cards grid) -----------------------------
  function cardInnerHtml(p) {
    var tools = p.tools && p.tools.items ? p.tools.items.length : 0
    var outs = p.allowGlobs ? p.allowGlobs.length : 0
    return (
      '<div class="wv-card-head">' +
      (typeof p.order === 'number' ? '<span class="wv-order">' + p.order + '</span>' : '') +
      '<span class="wv-title">' + esc(p.title || p.id) + '</span>' +
      (p.isInitial ? '<span class="wv-initial">● initial</span>' : '') +
      '</div>' +
      '<div class="wv-meta">' +
      '<span class="wv-chip">' + gateChip(p) + '</span>' +
      (tools ? '<span class="wv-chip">' + tools + ' tool' + (tools > 1 ? 's' : '') + '</span>' : '') +
      (outs ? '<span class="wv-chip">' + outs + ' output' + (outs > 1 ? 's' : '') + '</span>' : '') +
      '</div>'
    )
  }
  function makeCard(p, opts, ctx) {
    opts = opts || {}
    var card = document.createElement('div')
    card.className = 'wv-card' + (opts.center ? ' wv-center' : '')
    card.innerHTML = cardInnerHtml(p)
    if (opts.center) {
      card.style.cursor = 'default'
      return card
    }
    card.setAttribute('role', 'button')
    card.tabIndex = 0
    function open() {
      if (ctx && ctx.dragged && ctx.dragged()) return
      if (window.wandHost) window.wandHost.openPhaseDrawer(p.id)
    }
    card.addEventListener('click', open)
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        open()
      }
    })
    return card
  }
  function phaseCard(p, x, y, w, h, opts, ctx) {
    var fo = svg('foreignObject', { x: x, y: y, width: w, height: h })
    fo.appendChild(makeCard(p, opts, ctx))
    return fo
  }

  // ---- canvas (pan / zoom / fit) -------------------------------------------
  function arrowMarker(id) {
    var m = svg('marker', {
      id: id, viewBox: '0 0 10 10', refX: '9', refY: '5',
      markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse'
    })
    m.appendChild(svg('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--wv-accent)' }))
    return m
  }
  function button(label, title) {
    var b = document.createElement('button')
    b.type = 'button'
    b.className = 'wv-btn'
    b.textContent = label
    b.title = title
    b.setAttribute('aria-label', title)
    return b
  }

  // Build (or reuse) the pannable/zoomable SVG host. Returns a handle whose
  // `viewport` <g> callers fill; `setBBox`/`fit` frame the content; `dragged()`
  // lets click handlers ignore the click that ends a pan.
  function createCanvas(host) {
    if (host.__wvCanvas) return host.__wvCanvas
    injectCss()
    host.classList.add('wv-root')
    host.innerHTML = ''

    var wrap = document.createElement('div')
    wrap.className = 'wv-canvas'
    var svgEl = svg('svg', { class: 'wv-svg' })
    var defs = svg('defs')
    defs.appendChild(arrowMarker('wv-arrow'))
    svgEl.appendChild(defs)
    var viewport = svg('g', { class: 'wv-viewport' })
    svgEl.appendChild(viewport)
    wrap.appendChild(svgEl)

    var tools = document.createElement('div')
    tools.className = 'wv-tools'
    var bIn = button('+', 'Zoom in')
    var bOut = button('−', 'Zoom out')
    var bFit = button('⛶', 'Fit to view')
    tools.appendChild(bIn)
    tools.appendChild(bOut)
    tools.appendChild(bFit)
    wrap.appendChild(tools)
    host.appendChild(wrap)

    var view = { x: 0, y: 0, scale: 1 }
    var bbox = null
    function apply() {
      viewport.setAttribute('transform', 'translate(' + view.x + ',' + view.y + ') scale(' + view.scale + ')')
    }
    function size() {
      return { W: svgEl.clientWidth || host.clientWidth || 800, H: svgEl.clientHeight || host.clientHeight || 600 }
    }
    function fit() {
      if (!bbox || !(bbox.w > 0) || !(bbox.h > 0)) return
      var s0 = size()
      var s = clamp(Math.min(s0.W / bbox.w, s0.H / bbox.h) * 0.92, 0.2, 1.6)
      view.scale = s
      view.x = (s0.W - bbox.w * s) / 2 - bbox.x * s
      view.y = (s0.H - bbox.h * s) / 2 - bbox.y * s
      apply()
    }
    function zoomAt(px, py, factor) {
      var ns = clamp(view.scale * factor, 0.2, 3)
      var k = ns / view.scale
      view.x = px - (px - view.x) * k
      view.y = py - (py - view.y) * k
      view.scale = ns
      apply()
    }

    var drag = null
    svgEl.addEventListener('pointerdown', function (e) {
      drag = { x0: e.clientX, y0: e.clientY, vx: view.x, vy: view.y, moved: false }
      host.__wvDragged = false
      svgEl.classList.add('wv-grabbing')
    })
    // window-level so a drag keeps tracking if the pointer leaves the svg.
    window.addEventListener('pointermove', function (e) {
      if (!drag) return
      var dx = e.clientX - drag.x0
      var dy = e.clientY - drag.y0
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        drag.moved = true
        host.__wvDragged = true
      }
      view.x = drag.vx + dx
      view.y = drag.vy + dy
      apply()
    })
    window.addEventListener('pointerup', function () {
      if (!drag) return
      var moved = drag.moved
      drag = null
      svgEl.classList.remove('wv-grabbing')
      // Keep the flag through the click that follows a drag, then clear it.
      if (moved) setTimeout(function () { host.__wvDragged = false }, 0)
      else host.__wvDragged = false
    })
    svgEl.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault()
        var r = svgEl.getBoundingClientRect()
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015))
      },
      { passive: false }
    )
    bIn.onclick = function () {
      var r = svgEl.getBoundingClientRect()
      zoomAt(r.width / 2, r.height / 2, 1.2)
    }
    bOut.onclick = function () {
      var r = svgEl.getBoundingClientRect()
      zoomAt(r.width / 2, r.height / 2, 1 / 1.2)
    }
    bFit.onclick = fit

    host.__wvCanvas = {
      viewport: viewport,
      setBBox: function (b) {
        bbox = b
      },
      fit: fit,
      dragged: function () {
        return !!host.__wvDragged
      }
    }
    return host.__wvCanvas
  }

  // gently bowed connector; k offsets the control point perpendicular.
  function curve(x1, y1, x2, y2, k) {
    if (k == null) k = 0.1
    var mx = (x1 + x2) / 2
    var my = (y1 + y2) / 2
    var cx = mx + -(y2 - y1) * k
    var cy = my + (x2 - x1) * k
    return 'M' + x1 + ',' + y1 + ' Q' + cx + ',' + cy + ' ' + x2 + ',' + y2
  }
  function link(parent, x1, y1, x2, y2, cls, k) {
    parent.appendChild(svg('path', { class: cls + ' wv-draw', d: curve(x1, y1, x2, y2, k), pathLength: '1' }))
  }
  function flow(parent, x1, y1, x2, y2, k) {
    parent.appendChild(svg('path', { class: 'wv-flow', d: curve(x1, y1, x2, y2, k) }))
  }

  // ---- content extraction (from the real WandDetail) -----------------------
  function phaseName(p) {
    var t = clean(p.title || p.id).replace(/^phase\s*[:\-]?\s*/i, '')
    return titleCase(t || p.id)
  }
  function sectionBullets(md, section, max) {
    if (!md) return []
    var lines = md.split(/\r?\n/)
    var start = 0
    if (section) {
      var idx = -1
      for (var i = 0; i < lines.length; i++) {
        if (/^#{1,6}\s/.test(lines[i]) && lines[i].toLowerCase().indexOf(section.toLowerCase()) >= 0) {
          idx = i
          break
        }
      }
      if (idx < 0) return []
      start = idx + 1
    }
    var out = []
    for (var j = start; j < lines.length; j++) {
      var l = lines[j]
      if (section && /^#{1,6}\s/.test(l)) break
      var m = l.match(/^\s*[-*]\s+(.+)$/)
      if (m) out.push(clean(m[1]))
    }
    return out.slice(0, max || 6)
  }
  function primaryArtifact(detail) {
    var parts = [detail.wandPromptMarkdown || '']
    ;(detail.phases || []).forEach(function (p) {
      parts.push(p.promptMarkdown || '')
    })
    var blob = parts.join('\n')
    var counts = {}
    var re = /[A-Za-z0-9_\-]+\/[A-Za-z0-9._\-\/]+/g
    var m
    while ((m = re.exec(blob))) {
      var key = m[0].replace(/[.,)]+$/, '')
      if (/\.[a-z0-9]+$/i.test(key)) counts[key] = (counts[key] || 0) + 1
    }
    var best = null
    var bc = 0
    for (var k in counts) {
      if (counts[k] > bc) {
        best = k
        bc = counts[k]
      }
    }
    return best
  }

  // Build the radial model: center + branches (phases first, then meta facets),
  // each branch carrying leaf nodes. Draws everything the wand declares.
  function buildModel(detail) {
    var phases = detail.phases || []
    var dc = detail.directoryContract || {}
    var primary = primaryArtifact(detail)
    var branches = []

    phases.forEach(function (p) {
      var leaves = []
      if (p.isInitial) leaves.push({ label: 'initial phase' })
      leaves.push({ label: gateLabel(p.gate) })
      if (primary) leaves.push({ label: '→ ' + primary })
      if (p.tools && p.tools.items) {
        p.tools.items.slice(0, 2).forEach(function (t) {
          leaves.push({ label: 'tool · ' + t })
        })
      }
      sectionBullets(p.promptMarkdown, 'Required output', 3).forEach(function (b) {
        leaves.push({ label: b })
      })
      var pid = p.id
      branches.push({
        phase: true,
        label: phaseName(p),
        sub: (p.isInitial ? 'initial · ' : '') + gateLabel(p.gate),
        cls: 'wv-m-branch--phase',
        leaves: leaves.slice(0, 6),
        onClick: function () {
          if (window.wandHost) window.wandHost.openPhaseDrawer(pid)
        }
      })
    })

    var outLeaves = []
    ;(dc.requiredSubdirs || []).forEach(function (d) {
      outLeaves.push({ label: d + '/ · required' })
    })
    if (primary) outLeaves.push({ label: primary + ' · primary' })
    if (dc.folderName) outLeaves.push({ label: 'folder · ' + dc.folderName })
    ;(dc.initialFiles || []).forEach(function (f) {
      outLeaves.push({ label: 'seed · ' + f.path })
    })
    if (outLeaves.length) branches.push({ label: 'Outputs', leaves: outLeaves.slice(0, 6) })

    var toolSet = {}
    phases.forEach(function (p) {
      ;((p.tools && p.tools.items) || []).forEach(function (t) {
        toolSet[t] = true
      })
    })
    var tools = Object.keys(toolSet)
    var capLeaves = [
      { label: tools.length ? tools.length + ' extra tool' + (tools.length > 1 ? 's' : '') : 'baseline tools only' },
      {
        label:
          detail.mcpServers && detail.mcpServers.length
            ? 'MCP · ' + detail.mcpServers.join(', ')
            : 'no MCP servers'
      }
    ]
    if (
      phases.some(function (p) {
        return p.gate && p.gate.hasInputSchema
      })
    ) {
      capLeaves.push({ label: 'has input schema' })
    }
    branches.push({ label: 'Capabilities', leaves: capLeaves })

    var idLeaves = [{ label: 'appId · ' + detail.appId }]
    if (detail.appVersion) idLeaves.push({ label: 'v' + detail.appVersion })
    if (detail.alias) idLeaves.push({ label: 'alias · ' + detail.alias })
    idLeaves.push({ label: (detail.source && detail.source.type === 'plugin' ? 'plugin' : 'user') + ' wand' })
    idLeaves.push({ label: 'flow · ' + detail.flowMode })
    branches.push({ label: 'Identity', leaves: idLeaves })

    var rules = sectionBullets(detail.wandPromptMarkdown, 'Global rules', 6)
    if (rules.length) {
      branches.push({
        label: 'Global rules',
        leaves: rules.map(function (r) {
          return { label: r }
        })
      })
    }

    return {
      center: {
        label: detail.alias || detail.displayName || detail.appId,
        sub: detail.description || detail.displayName || ''
      },
      branches: branches
    }
  }

  // Branches own disjoint angular sectors sized by leaf count; leaves fan within
  // their parent's sector, alternating radius to avoid neighbour overlap.
  function layoutMindmap(model) {
    var cx = 500
    var cy = 500
    var start = -Math.PI / 2
    var weights = model.branches.map(function (b) {
      return Math.max(b.leaves.length, 1)
    })
    var total =
      weights.reduce(function (a, b) {
        return a + b
      }, 0) || 1
    var acc = 0
    model.branches.forEach(function (b, i) {
      var sector = (weights[i] / total) * Math.PI * 2
      var ca = start + acc + sector / 2
      b.angle = ca
      b.x = cx + R1 * Math.cos(ca)
      b.y = cy + R1 * Math.sin(ca)
      var L = b.leaves.length
      var pad = Math.min(sector * 0.16, 0.14)
      var span = Math.max(sector - pad * 2, 1e-4)
      b.leaves.forEach(function (lf, j) {
        var a = L === 1 ? ca : start + acc + pad + span * (j / (L - 1))
        var R = R2A + (j % 2) * (R2B - R2A)
        lf.angle = a
        lf.x = cx + R * Math.cos(a)
        lf.y = cy + R * Math.sin(a)
      })
      acc += sector
    })
    model.center.x = cx
    model.center.y = cy
  }

  function makeMNode(parent, node, kind, ctx, bbox, idx) {
    var cls =
      'wv-mnode wv-m-' + kind + (node.cls ? ' ' + node.cls : '') + (node.onClick ? ' wv-mclick' : '')
    var g = svg('g', { class: cls })
    g.style.animationDelay = Math.min(idx, 48) * 14 + 'ms'

    var tWeight = kind === 'center' ? '700' : kind === 'branch' ? '600' : '500'
    var tSize = kind === 'center' ? 16 : kind === 'branch' ? 13.5 : 11.5
    var label = truncate(node.label, kind === 'leaf' ? 30 : kind === 'center' ? 28 : 22)
    var sub = node.sub ? truncate(node.sub, kind === 'center' ? 40 : 26) : ''
    var wT = measure(label, tWeight, tSize)
    var wS = sub ? measure(sub, '400', kind === 'center' ? 11.5 : 10.5) : 0
    var padX = kind === 'leaf' ? 10 : kind === 'center' ? 16 : 13
    var w = clamp(Math.max(wT, wS) + padX * 2, kind === 'leaf' ? 56 : 92, kind === 'center' ? 330 : 220)
    var h = sub ? (kind === 'center' ? 54 : 42) : kind === 'leaf' ? 26 : 32
    var x = node.x - w / 2
    var y = node.y - h / 2
    var rx = kind === 'leaf' ? 7 : 11

    // opaque backing first → occludes any edge passing behind this node
    g.appendChild(svg('rect', { class: 'wv-mbg', x: x, y: y, width: w, height: h, rx: rx, ry: rx }))
    g.appendChild(svg('rect', { class: 'wv-mface', x: x, y: y, width: w, height: h, rx: rx, ry: rx }))

    if (sub) {
      var t1 = svg('text', { class: 'wv-mtitle', x: node.x, y: node.y - 8, 'text-anchor': 'middle' })
      t1.textContent = label
      var t2 = svg('text', { class: 'wv-msub', x: node.x, y: node.y + 10, 'text-anchor': 'middle' })
      t2.textContent = sub
      g.appendChild(t1)
      g.appendChild(t2)
    } else {
      var t = svg('text', { class: 'wv-mtitle', x: node.x, y: node.y, 'text-anchor': 'middle' })
      t.textContent = label
      g.appendChild(t)
    }

    var tip = svg('title')
    tip.textContent = node.label + (node.sub ? ' — ' + node.sub : '')
    g.appendChild(tip)

    if (node.onClick) {
      g.setAttribute('role', 'button')
      g.setAttribute('tabindex', '0')
      var fire = function () {
        if (ctx && ctx.dragged && ctx.dragged()) return
        node.onClick()
      }
      g.addEventListener('click', fire)
      g.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          fire()
        }
      })
    }

    bbox.minX = Math.min(bbox.minX, x)
    bbox.minY = Math.min(bbox.minY, y)
    bbox.maxX = Math.max(bbox.maxX, x + w)
    bbox.maxY = Math.max(bbox.maxY, y + h)
    parent.appendChild(g)
  }

  // ---- renderers -----------------------------------------------------------
  function renderMindmap(canvas, detail, ctx) {
    var vp = canvas.viewport
    var model = buildModel(detail)
    layoutMindmap(model)
    var bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    var linear = detail.flowMode !== 'free'

    // edges (under the nodes)
    model.branches.forEach(function (b) {
      link(vp, model.center.x, model.center.y, b.x, b.y, b.phase ? 'wv-link wv-link--phase' : 'wv-link', 0.06)
      b.leaves.forEach(function (lf) {
        link(vp, b.x, b.y, lf.x, lf.y, 'wv-leaflink', 0.1)
      })
    })
    // phase → phase flow (the workflow sequence), bowed around the center
    if (linear) {
      var ph = model.branches.filter(function (b) {
        return b.phase
      })
      for (var i = 1; i < ph.length; i++) {
        flow(vp, ph[i - 1].x, ph[i - 1].y, ph[i].x, ph[i].y, 0.28)
      }
    }

    // nodes: leaves → branches → center (z-order: opaque nodes hide edge ends)
    var idx = 0
    model.branches.forEach(function (b) {
      b.leaves.forEach(function (lf) {
        makeMNode(vp, lf, 'leaf', ctx, bbox, idx++)
      })
    })
    model.branches.forEach(function (b) {
      makeMNode(vp, b, 'branch', ctx, bbox, idx++)
    })
    makeMNode(vp, model.center, 'center', ctx, bbox, idx++)

    return { x: bbox.minX, y: bbox.minY, w: bbox.maxX - bbox.minX, h: bbox.maxY - bbox.minY }
  }

  function renderFlow(canvas, detail, ctx) {
    var vp = canvas.viewport
    var phases = detail.phases || []
    var padX = 28
    var padY = 24
    var gapY = 46
    var w = CARD_W + padX * 2
    var h = padY * 2 + phases.length * CARD_H + Math.max(0, phases.length - 1) * gapY
    var linear = detail.flowMode !== 'free'
    phases.forEach(function (p, i) {
      var x = padX
      var y = padY + i * (CARD_H + gapY)
      if (linear && i > 0) {
        var py = padY + (i - 1) * (CARD_H + gapY) + CARD_H
        flow(vp, x + CARD_W / 2, py, x + CARD_W / 2, y, 0)
      }
      vp.appendChild(phaseCard(p, x, y, CARD_W, CARD_H, {}, ctx))
    })
    return { x: 0, y: 0, w: w, h: h }
  }

  function renderCards(host, detail, ctx) {
    var grid = document.createElement('div')
    grid.className = 'wv-grid'
    ;(detail.phases || []).forEach(function (p) {
      grid.appendChild(makeCard(p, {}, ctx))
    })
    host.appendChild(grid)
  }

  // ---- shell ---------------------------------------------------------------
  function legend(text) {
    var d = document.createElement('div')
    d.className = 'wv-legend'
    d.textContent = text
    return d
  }
  function showError(host, msg) {
    host.classList.add('wv-root')
    host.__wvCanvas = null
    host.innerHTML = ''
    var d = document.createElement('div')
    d.className = 'wv-error'
    d.textContent = msg
    host.appendChild(d)
  }
  function clearChildren(n) {
    while (n.firstChild) n.removeChild(n.firstChild)
  }
  function bindLive(host, opts) {
    if (host.__wvBound) return
    host.__wvBound = true
    if (window.wandHost) {
      window.wandHost.on('files-changed', function () {
        mount(opts)
      })
    }
  }

  function mount(opts) {
    opts = opts || {}
    var host = el(opts.el || '#app')
    if (!host) {
      console.error('[wandViz] mount target not found:', opts.el)
      return
    }
    var mode = opts.mode === 'mindmap' ? 'mindmap' : opts.mode === 'cards' ? 'cards' : 'flow'
    injectCss()
    if (!window.wandHost) {
      showError(host, 'wand-host SDK not loaded')
      return
    }

    // `opts.getDetail` lets a view render any WandDetail-shaped object instead
    // of the host wand itself — e.g. WandPlus's runtime view renders the wand
    // *under construction* from output/wand.json. files-changed re-mounts run
    // it again, so the picture grows live with the artifact.
    var getDetail = opts.getDetail || function () { return window.wandHost.get() }

    // Bind the live re-mount up front (idempotent): a view whose FIRST render
    // fails (artifact not produced yet) must still refresh when files appear.
    bindLive(host, opts)

    Promise.resolve()
      .then(getDetail)
      .then(function (detail) {
        if (!detail || !detail.phases || !detail.phases.length) {
          showError(host, 'This wand has no phases to display.')
          return
        }
        var ctx = {
          host: host,
          dragged: function () {
            return !!host.__wvDragged
          }
        }
        if (mode === 'cards') {
          host.__wvCanvas = null
          host.classList.add('wv-root')
          host.innerHTML = ''
          if (detail.flowMode === 'free') {
            host.appendChild(legend('Free flow — the agent chooses the next step at runtime; order is illustrative.'))
          }
          renderCards(host, detail, { dragged: function () { return false } })
          return
        }
        var canvas = createCanvas(host)
        clearChildren(canvas.viewport)
        var bbox = mode === 'mindmap' ? renderMindmap(canvas, detail, ctx) : renderFlow(canvas, detail, ctx)
        canvas.setBBox(bbox)
        canvas.fit()
      })
      .catch(function (err) {
        showError(host, 'Failed to load wand: ' + (err && err.message ? err.message : String(err)))
      })
  }

  // ---- HUD (runtime views, see spec/presentation.md) -----------------------
  // Zero-code current-phase indicator for full-page (shell-less) runtime views:
  // a floating chip fed by runtime.getState + state-changed, pulsing briefly on
  // files-changed. Opt-in via `<div data-wv-hud>` or `wandViz.hud()`. Hidden in
  // static views (no runtime state to show).
  function hud(target) {
    injectCss()
    if (!window.wandHost) return null
    var box = typeof target === 'string' ? el(target) : target
    var chip = document.createElement('div')
    chip.className = 'wv-hud'
    chip.style.display = 'none'
    var dot = document.createElement('span')
    dot.className = 'wv-hud-dot'
    var text = document.createElement('span')
    chip.appendChild(dot)
    chip.appendChild(text)
    ;(box && box !== document.body ? box : document.body).appendChild(chip)

    var pulseTimer = null
    function update(state) {
      if (!state) return
      chip.style.display = 'flex'
      if (state.currentPhase) {
        chip.classList.remove('wv-hud--done')
        text.textContent = state.currentPhase
      } else {
        chip.classList.add('wv-hud--done')
        text.textContent = 'done'
      }
    }
    function pulse() {
      chip.classList.add('wv-hud--pulse')
      if (pulseTimer) clearTimeout(pulseTimer)
      pulseTimer = setTimeout(function () {
        chip.classList.remove('wv-hud--pulse')
      }, 1500)
    }

    window.wandHost.getRuntimeState().then(update).catch(function () {})
    window.wandHost.on('state-changed', update)
    window.wandHost.on('files-changed', pulse)
    return chip
  }

  function autoMount() {
    var nodes = document.querySelectorAll('[data-wv-mode]')
    for (var i = 0; i < nodes.length; i++) {
      mount({ el: nodes[i], mode: nodes[i].getAttribute('data-wv-mode') })
    }
    var huds = document.querySelectorAll('[data-wv-hud]')
    for (var j = 0; j < huds.length; j++) {
      hud(huds[j])
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount)
  } else {
    autoMount()
  }

  window.wandViz = {
    mount: mount,
    canvas: createCanvas,
    hud: hud,
    renderFlow: renderFlow,
    renderMindmap: renderMindmap,
    renderCards: renderCards
  }
})()
