/**
 * LyCanvas — Pixel-perfect layout overlay
 *
 * Renders the accessibility tree as an interactive wireframe that
 * mirrors the exact visual layout of the device screen:
 *
 *   - Nodes drawn at exact scaled positions (getBoundsInScreen coords)
 *   - Z-ordered by windowType: app → system UI → keyboard → overlays
 *   - Within each window, sorted large→small so small nodes sit on top
 *   - Container nodes (large, no text): very faint outline only
 *   - Interactive nodes: bright border + centered label
 *   - Keyboard keys: own rendering pass for clarity
 *   - Text is always centered inside its bounding box
 *   - HiDPI-aware (devicePixelRatio scaling)
 *   - Double-buffered via OffscreenCanvas when available
 *
 * Tap wiring:
 *   Hit-test converts canvas CSS px → device px via stored scale.
 *   Finds smallest node containing the point → sends TAP with real
 *   device px center (no scale: param = APK raw fallback path).
 *   Free tap/swipe on empty area also converts to device px.
 */
import { useLayoutEffect, useRef, useImperativeHandle, forwardRef } from 'react';

// ── Window type Z-order (lower = drawn first = behind) ─────────────────────
// From AccessibilityWindowInfo: 1=app, 2=overlay, 3=ime, 4=system
const WIN_Z = { 1: 0, 4: 1, 3: 2, 2: 3, null: 0, undefined: 0 };

// ── Color palette ──────────────────────────────────────────────────────────
function nodeColor(n) {
  if (!n.enabled)       return '#374151';
  if (n.focused)        return '#f9fafb';
  if (n.isPinDigit)     return '#60a5fa';
  if (n.isPatternLock)  return '#818cf8';
  if (n.password)       return '#f87171';
  if (n.isKeyboard)     return '#c084fc';
  if (n.editable)       return '#34d399';
  if (n.scrollable)     return '#4ade80';
  if (n.clickable)      return '#fbbf24';
  return '#374151';
}

// ── Is this a "leaf" interactive node? ────────────────────────────────────
// Containers have many children and large area — render them faintly.
// Leaf nodes are the actual interactive/text elements — render them bright.
function isLeaf(n) {
  return n.clickable || n.editable || n.scrollable || n.isPinDigit ||
         n.isKeyboard || n.isPatternLock || !!n.text;
}

// ── Node area in device px² ────────────────────────────────────────────────
function area(n) {
  if (!n.bounds) return Infinity;
  return (n.bounds.right - n.bounds.left) * (n.bounds.bottom - n.bounds.top);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main draw function — returns scale info for hit-testing
function drawLY(canvas, nodes, options = {}) {
  if (!canvas) return null;
  const { highlight, searchTerm, showLabels = true, showContainers = false } = options;

  // ── Infer screen dimensions ──────────────────────────────────────────────
  let maxX = 0, maxY = 0;
  for (const n of nodes) {
    if (!n.bounds) continue;
    if (n.bounds.right  > maxX) maxX = n.bounds.right;
    if (n.bounds.bottom > maxY) maxY = n.bounds.bottom;
  }
  if (!maxX || !maxY) {
    // Draw empty state
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) { ctx.fillStyle = '#060810'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    return null;
  }

  const dpr  = Math.min(window.devicePixelRatio || 1, 3);
  const logW = canvas.clientWidth || 350;
  const logH = Math.round(logW * maxY / maxX);

  // Only resize backing store when dimensions actually change
  const targetW = Math.round(logW * dpr);
  const targetH = Math.round(logH * dpr);
  let resized = false;
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width  = targetW;
    canvas.height = targetH;
    canvas.style.height = logH + 'px';
    resized = true;
  }

  // ── Use OffscreenCanvas when available to avoid main-thread paint stall ──
  let target = canvas;
  let offscreen = null;
  if (typeof OffscreenCanvas !== 'undefined' && !resized) {
    try {
      offscreen = new OffscreenCanvas(targetW, targetH);
      target    = offscreen;
    } catch(_) {}
  }

  const ctx = target.getContext('2d', { alpha: false, willReadFrequently: false });
  if (!ctx) return null;

  const sx = targetW / maxX;
  const sy = targetH / maxY;

  // ── Background ──────────────────────────────────────────────────────────
  ctx.fillStyle = '#07090f';
  ctx.fillRect(0, 0, targetW, targetH);

  // Subtle dot grid for depth perception
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  const gx = Math.round(maxX / 12) * sx;
  const gy = Math.round(maxY / 24) * sy;
  for (let x = gx; x < targetW; x += gx)
    for (let y = gy; y < targetH; y += gy) {
      ctx.beginPath(); ctx.arc(x, y, 0.8 * dpr, 0, Math.PI * 2); ctx.fill();
    }

  // ── Partition nodes by window type for Z-ordering ──────────────────────
  const byZ = {};
  for (const n of nodes) {
    if (!n.bounds) continue;
    const z = WIN_Z[n.windowType] ?? 0;
    if (!byZ[z]) byZ[z] = [];
    byZ[z].push(n);
  }

  // Within each Z layer sort large→small (containers first, leaves on top)
  const sortedLayers = Object.keys(byZ)
    .sort((a, b) => +a - +b)
    .map(z => byZ[z].sort((a, b) => area(b) - area(a)));

  // ── Search state ────────────────────────────────────────────────────────
  const hasSearch  = !!(searchTerm?.length);
  const matchTerm  = hasSearch ? searchTerm.toLowerCase() : '';

  // ── Font setup ──────────────────────────────────────────────────────────
  const MIN_FS  = 7  * dpr;
  const MAX_FS  = 13 * dpr;

  // ── Draw passes ─────────────────────────────────────────────────────────
  for (const layer of sortedLayers) {
    for (const n of layer) {
      const { left, top, right, bottom } = n.bounds;
      const x = left  * sx, y = top   * sy;
      const w = (right - left) * sx, h = (bottom - top) * sy;
      if (w < 1 || h < 1) continue;

      const leaf    = isLeaf(n);
      const isHit   = highlight === n;
      const isMatch = hasSearch && (
        n.text?.toLowerCase().includes(matchTerm) ||
        n.cls.toLowerCase().includes(matchTerm)
      );
      const dimmed  = hasSearch && !isMatch && !isHit;

      // Skip pure containers unless showContainers is on or they match search
      if (!leaf && !showContainers && !isMatch && !isHit) {
        // Draw minimal ghost border for layout context
        ctx.globalAlpha = dimmed ? 0.04 : 0.07;
        ctx.strokeStyle = '#475569';
        ctx.lineWidth   = 0.5 * dpr;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        ctx.globalAlpha = 1;
        continue;
      }

      const col        = nodeColor(n);
      const baseAlpha  = !n.enabled ? 0.2 : isHit ? 1 : isMatch ? 0.95 : dimmed ? 0.15 : 0.8;
      const fillAlpha  = isHit ? 0.25 : isMatch ? 0.12 : leaf ? 0.06 : 0.02;
      const strokeW    = (isHit ? 2.5 : isMatch ? 2 : n.focused ? 2 : leaf ? 1.5 : 0.7) * dpr;

      // Fill
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle   = isHit ? '#ffffff' : col;
      ctx.fillRect(x, y, w, h);

      // Border
      ctx.globalAlpha = baseAlpha;
      ctx.strokeStyle = isHit ? '#ffffff' : col;
      ctx.lineWidth   = strokeW;
      ctx.strokeRect(x + strokeW / 2, y + strokeW / 2, w - strokeW, h - strokeW);
      ctx.globalAlpha = 1;

      // ── Focused: corner bracket decoration ──────────────────────────────
      if (n.focused || isHit) {
        const m = Math.min(w * 0.22, h * 0.22, 16 * dpr);
        ctx.strokeStyle = isHit ? '#ffffff' : '#f9fafb';
        ctx.lineWidth   = 2 * dpr;
        ctx.globalAlpha = isHit ? 1 : 0.9;
        [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([cx,cy],i) => {
          const dx = i < 2 ? 1 : -1, dy = i % 2 === 0 ? 1 : -1;
          ctx.beginPath();
          ctx.moveTo(cx + dx * m, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + dy * m);
          ctx.stroke();
        });
        ctx.globalAlpha = 1;
      }

      // ── Keyboard key: mini filled pill ──────────────────────────────────
      if (n.isKeyboard && n.keyType && n.text && w > 8 * dpr && h > 8 * dpr) {
        const inset = 1.5 * dpr;
        const r     = Math.min(3 * dpr, w / 3, h / 3);
        ctx.globalAlpha = baseAlpha * 0.18;
        ctx.fillStyle   = col;
        ctx.beginPath();
        if (ctx.roundRect) {
          ctx.roundRect(x + inset, y + inset, w - inset * 2, h - inset * 2, r);
        } else {
          ctx.rect(x + inset, y + inset, w - inset * 2, h - inset * 2);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      // ── Label — centered in node ─────────────────────────────────────────
      if (!showLabels) continue;
      const label = n.text || (leaf && n.cls ? n.cls.split('.').pop() : '');
      if (!label) continue;

      // Dynamic font size: fit the label height to ~35% of node height
      const fs = Math.max(MIN_FS, Math.min(MAX_FS, h * 0.35, w * 0.45));
      ctx.font = `${Math.round(fs)}px -apple-system,'Helvetica Neue',sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign    = 'center';
      ctx.fillStyle    = isHit ? '#ffffff' : col;
      ctx.globalAlpha  = Math.min(1, baseAlpha * 1.1);

      // Truncate to fit box width
      const maxW = w - 4 * dpr;
      let txt = label;
      if (ctx.measureText(txt).width > maxW) {
        while (txt.length > 1 && ctx.measureText(txt + '…').width > maxW)
          txt = txt.slice(0, -1);
        txt += '…';
      }
      // Only draw if text isn't tiny
      if (fs > MIN_FS || label.length <= 3) {
        // Background pill for legibility on overlapping boxes
        const tw = ctx.measureText(txt).width;
        if (tw > 2) {
          ctx.globalAlpha = fillAlpha * 3;
          ctx.fillStyle   = '#07090f';
          ctx.fillRect(
            x + w / 2 - tw / 2 - 2 * dpr,
            y + h / 2 - fs / 2 - 1 * dpr,
            tw + 4 * dpr, fs + 2 * dpr
          );
        }
        ctx.globalAlpha = Math.min(1, baseAlpha * 1.1);
        ctx.fillStyle   = isHit ? '#ffffff' : col;
        ctx.fillText(txt, x + w / 2, y + h / 2);
      }
      ctx.globalAlpha  = 1;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign    = 'left';
    }
  }

  // ── Crosshair at last tap point ──────────────────────────────────────────
  if (options.lastTap) {
    const { devX, devY } = options.lastTap;
    const px = devX * sx, py = devY * sy;
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 1 * dpr;
    ctx.setLineDash([3 * dpr, 3 * dpr]);
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, targetH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(targetW, py); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(px, py, 4 * dpr, 0, Math.PI * 2);
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
  }

  // ── Flush OffscreenCanvas to visible canvas ──────────────────────────────
  if (offscreen) {
    const visCtx = canvas.getContext('2d', { alpha: false });
    if (visCtx) {
      visCtx.drawImage(offscreen, 0, 0);
    }
  }

  return { sx, sy, logW, logH, maxX, maxY, dpr };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit-test: canvas CSS px → device px → smallest containing node
function hitTest(cssPx, canvas, scale, nodes) {
  if (!scale || !canvas) return { node: null, devX: 0, devY: 0 };
  const r    = canvas.getBoundingClientRect();
  const devX = ((cssPx.x - r.left) / r.width)  * scale.maxX;
  const devY = ((cssPx.y - r.top)  / r.height) * scale.maxY;
  return {
    node: nodes
      .filter(n => n.bounds &&
        devX >= n.bounds.left && devX <= n.bounds.right &&
        devY >= n.bounds.top  && devY <= n.bounds.bottom)
      .sort((a, b) => area(a) - area(b))[0] ?? null,
    devX: Math.round(devX),
    devY: Math.round(devY),
  };
}

function cssToDevice(cssPx, canvas, scale) {
  if (!scale || !canvas) return { devX: 0, devY: 0 };
  const r = canvas.getBoundingClientRect();
  return {
    devX: Math.round(((cssPx.x - r.left) / r.width)  * scale.maxX),
    devY: Math.round(((cssPx.y - r.top)  / r.height) * scale.maxY),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LyCanvas component
const LyCanvas = forwardRef(function LyCanvas(
  { nodes, highlight, searchTerm, showLabels, showContainers, lastTap, onScale },
  ref
) {
  const canvasRef  = useRef(null);
  const scaleRef   = useRef(null);

  // Expose hit-test to parent without passing scale as prop
  useImperativeHandle(ref, () => ({
    hitTest: cssPx => hitTest(cssPx, canvasRef.current, scaleRef.current, nodes),
    cssToDevice: cssPx => cssToDevice(cssPx, canvasRef.current, scaleRef.current),
  }), [nodes]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !nodes.length) return;
    const scale = drawLY(canvas, nodes, {
      highlight, searchTerm, showLabels, showContainers, lastTap,
    });
    scaleRef.current = scale;
    onScale?.(scale);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, highlight, searchTerm, showLabels, showContainers, lastTap]);

  return (
    <canvas
      ref={canvasRef}
      style={{ display: 'block', width: '100%', imageRendering: 'auto' }}
    />
  );
});

export { LyCanvas, nodeColor };
export default LyCanvas;
