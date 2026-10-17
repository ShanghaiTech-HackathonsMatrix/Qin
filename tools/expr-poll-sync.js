(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  tabs().find((b) => b.textContent.includes('设置'))?.click();
  await sleep(1200);
  const snap = () => {
    const conns = [...document.querySelectorAll('.conn')];
    return conns.slice(0, 3).map((c) => {
      const t = c.querySelector('.conn__title strong')?.textContent?.trim() || '?';
      const txt = c.innerText.replace(/\s+/g, ' ').trim();
      const busy = [...c.querySelectorAll('button')].some((b) => b.disabled && b.textContent.includes('处理中'));
      return t + (busy ? ' [跑着] ' : ' ') + txt.slice(t.length).slice(0, 150);
    });
  };
  const out = [];
  for (let i = 0; i < 10; i += 1) {
    out.push('[' + i * 10 + 's] ' + snap().join(' ‖ '));
    await sleep(10000);
  }
  return out.join('\n');
})()