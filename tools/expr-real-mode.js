(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));

  // 真机/非模拟：设置页应当是诚实的「登不了」，按钮禁用
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(700);
  out.push('设置·平台连接 = ' + JSON.stringify([...document.querySelectorAll('.conn')].map((c) => ({
    title: (c.querySelector('.conn__title strong')?.textContent || '').trim(),
    status: (c.querySelector('.conn__status')?.textContent || '').trim(),
    notes: [...c.querySelectorAll('.conn__note')].map((n) => n.textContent.trim()).slice(0, 1),
    buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.disabled ? '(禁用)' : '')),
  })), null, 1));

  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(700);
  out.push('首页顶栏 = ' + JSON.stringify((document.querySelector('.topbar')?.textContent || '').replace(/\s+/g, ' ').trim()));
  out.push('底部栏 = ' + JSON.stringify([...document.querySelectorAll('.tabbar button')].map((b) => b.textContent.trim())));
  out.push('下一节课卡 = ' + JSON.stringify((document.querySelector('.next-class-card')?.textContent || '(没有)').replace(/\s+/g, ' ').trim()));
  return out.join('\n');
})()