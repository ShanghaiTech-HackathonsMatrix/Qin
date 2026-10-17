(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  tabs().find((b) => b.textContent.includes('设置'))?.click();
  await sleep(2000);

  const rows = [...document.querySelectorAll('.conn')];
  out.push('平台行数 = ' + rows.length);
  rows.forEach((r, i) => {
    out.push(`#${i} ` + r.innerText.replace(/\s+/g, ' ').slice(0, 60)
      + ' | buttons=' + JSON.stringify([...r.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.disabled ? '(禁用)' : ''))));
  });

  const target = rows.find((r) => r.innerText.includes('互动教学平台'));
  if (!target) return out.join('\n') + '\n没找到互动教学平台';
  const sync = [...target.querySelectorAll('button')].find((b) => b.textContent.trim() === '同步');
  if (!sync) return out.join('\n') + '\n没找到「同步」按钮';
  out.push('--- 点同步 ---');
  sync.click();
  for (let i = 0; i < 24; i += 1) {
    await sleep(5000);
    const r = [...document.querySelectorAll('.conn')].find((x) => x.innerText.includes('互动教学平台'));
    if (!r) { out.push(`[${(i + 1) * 5}s] 行消失`); continue; }
    const busy = [...r.querySelectorAll('button')].some((b) => b.disabled && b.textContent.includes('处理中'));
    out.push(`[${(i + 1) * 5}s]${busy ? ' 跑着' : ' 停了'} ` + r.innerText.replace(/\s+/g, ' ').slice(0, 160));
    if (!busy) break;
  }
  return out.join('\n');
})()