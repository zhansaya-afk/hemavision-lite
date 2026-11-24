// Ручная отметка тканей: кисть по веку (красная), касания по склере (синие круги).
// Маски строятся в разрешении снимка; внутри отметки блики, тени и ресницы убирает features.tissueMask.

export function createRoi(photo, draw, src) {
  const W = src.width, H = src.height;
  photo.width = draw.width = W;
  photo.height = draw.height = H;
  photo.getContext('2d').drawImage(src, 0, 0);
  const ctx = draw.getContext('2d');
  const side = Math.max(W, H);
  const rLid = Math.max(4, Math.round(0.02 * side));
  const rSclera = Math.max(4, Math.round(0.025 * side));
  const actions = [];
  let mode = 'lid';
  let current = null;
  let onChange = () => {};

  function paint(c, items, opaque) {
    for (const a of items) {
      if (a.type === 'lid') {
        c.strokeStyle = opaque ? '#000' : 'rgba(211,58,44,0.45)';
        c.fillStyle = c.strokeStyle;
        c.lineWidth = 2 * a.r; c.lineCap = 'round'; c.lineJoin = 'round';
        c.beginPath();
        a.pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y)));
        if (a.pts.length === 1) { c.arc(a.pts[0][0], a.pts[0][1], a.r, 0, 2 * Math.PI); c.fill(); } else c.stroke();
      } else {
        c.fillStyle = opaque ? '#000' : 'rgba(37,99,235,0.30)';
        c.strokeStyle = opaque ? '#000' : '#2563eb';
        c.lineWidth = opaque ? 1 : 3;
        c.beginPath(); c.arc(a.x, a.y, a.r, 0, 2 * Math.PI); c.fill(); c.stroke();
      }
    }
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    paint(ctx, current ? [...actions, current] : actions, false);
    onChange(counts());
  }

  function pos(e) {
    const r = draw.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
  }

  const pointers = new Set();
  draw.addEventListener('pointerdown', (e) => {
    pointers.add(e.pointerId);
    if (pointers.size > 1) { current = null; render(); return; }   // два пальца — масштаб страницы, не рисуем
    const [x, y] = pos(e);
    if (mode === 'lid') {
      draw.setPointerCapture(e.pointerId);
      current = { type: 'lid', pts: [[x, y]], r: rLid };
    } else {
      actions.push({ type: 'sclera', x, y, r: rSclera });
    }
    render();
  });
  draw.addEventListener('pointermove', (e) => {
    if (!current || pointers.size > 1) return;
    current.pts.push(pos(e));
    render();
  });
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (current) { actions.push(current); current = null; render(); }
  };
  draw.addEventListener('pointerup', end);
  draw.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); current = null; render(); });

  function mask(type) {
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const c = off.getContext('2d', { willReadFrequently: true });
    paint(c, actions.filter((a) => a.type === type), true);
    const a = c.getImageData(0, 0, W, H).data;
    const m = new Uint8Array(W * H);
    for (let i = 0; i < m.length; i++) m[i] = a[4 * i + 3] > 127 ? 1 : 0;
    return m;
  }

  function counts() {
    return { lid: actions.filter((a) => a.type === 'lid').length, sclera: actions.filter((a) => a.type === 'sclera').length };
  }

  render();
  return {
    setMode(m) { mode = m; },
    getMode: () => mode,
    undo() { actions.pop(); render(); },
    reset() { actions.length = 0; render(); },
    counts,
    masks: () => ({ lid: mask('lid'), sclera: mask('sclera') }),
    set onChange(fn) { onChange = fn; fn(counts()); },
  };
}
