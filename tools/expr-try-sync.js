(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  tabs().find((b) => b.textContent.includes('设置'))?.click();
  await sleep(1200);

  const row = () => [...document.querySelectorAll('.conn')].find((c) => c.innerText.includes('互动教学平台'));
  const before = row()?.innerText.replace(/\s+/g, ' ').trim();
  out.push('点之前: ' + before);

  const btns = [...row().querySelectorAll('button')];
  const syncBtn = btns.find((b) => b.textContent.includes('同步'));
  if (!syncBtn) return '找不到同步按钮';
  syncBtn.click();

  for (let i = 0; i < 24; i += 1) {
    await sleep(5000);
    const r = row();
    if (!r) { out.push(`[${(i + 1) * 5}s] 行不见了`); continue; }
    const txt = r.innerText.replace(/\s+/g, ' ').trim();
    const busy = [...r.querySelectorAll('button')].some((b) => b.disabled && b.textContent.includes('处理中'));
    out.push(`[${(i + 1) * 5}s]${busy ? ' 跑着' : ' 停了'} ${txt}`);
    if (!busy) break;
  }
  return out.join('\n');
})()