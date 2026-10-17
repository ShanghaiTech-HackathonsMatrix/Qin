(() => {
  // 把整页用到的颜色全捞出来，看看有没有跳出黑白灰的
  const seen = new Map();
  const bump = (v, where) => {
    if (!v) return;
    const key = v;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(where);
  };
  const props = ['color', 'backgroundColor', 'borderTopColor', 'borderLeftColor', 'outlineColor', 'fill', 'stroke'];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    for (const p of props) {
      const v = cs[p];
      if (!v || v === 'none') continue;
      if (v === 'rgba(0, 0, 0, 0)') continue;
      bump(v, p);
    }
  }
  const isGray = (v) => {
    const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return true; // currentColor 等非 rgb 值先放过
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return Math.abs(r - g) <= 6 && Math.abs(g - b) <= 6 && Math.abs(r - b) <= 6;
  };
  const colorful = [...seen.entries()].filter(([v]) => !isGray(v));
  return JSON.stringify({
    页面: location.search + ' / ' + (document.querySelector('.app__body')?.dataset.page ?? '?'),
    颜色总数: seen.size,
    非黑白灰: colorful.map(([v, w]) => v + '  ← ' + [...w].join(',')),
    全部: [...seen.keys()],
  }, null, 1);
})()