(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  tabs().find((b) => b.textContent.includes('设置'))?.click();
  await sleep(1200);
  out.push('底栏 = ' + JSON.stringify(tabs().map((b) => b.textContent.trim())));

  const conns = [...document.querySelectorAll('.conn')];
  for (const c of conns) {
    const title = c.querySelector('.conn__title strong')?.textContent?.trim()
      || c.querySelector('.conn__title')?.textContent?.trim() || '?';
    const badge = c.querySelector('.conn__badge')?.textContent?.trim() || '';
    // 把整块文字都摊出来，别猜类名
    out.push('【' + title + '】badge=' + badge + ' 全文=' + c.innerText.replace(/\s+/g, ' ').slice(0, 220));
    out.push('   按钮状态 = ' + JSON.stringify([...c.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.disabled ? '(禁用)' : ''))));
  }
  return out.join('\n');
})()