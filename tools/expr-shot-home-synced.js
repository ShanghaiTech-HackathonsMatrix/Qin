(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  const out = [];
  const readHome = () => ({
    next: (document.querySelector('.next-class-card')?.textContent || '(没有下一节课)').replace(/\s+/g, ' ').trim(),
    ddls: [...document.querySelectorAll('.ddl-card')].map((c) => ({
      t: (c.querySelector('.ddl-card__time strong')?.textContent || '').trim(),
      title: (c.querySelector('.ddl-card__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
      meta: (c.querySelector('.ddl-card__body small')?.textContent || '').trim(),
    })),
  });
  out.push('同步前首页 = ' + JSON.stringify(readHome(), null, 1));
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(700);
  for (const i of [0, 1, 2]) {
    btnHas(document.querySelectorAll('.conn')[i], '同步')?.click();
    await sleep(2000);
  }
  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(900);
  out.push('同步后首页 = ' + JSON.stringify(readHome(), null, 1));
  out.push('底部栏 = ' + JSON.stringify([...document.querySelectorAll('.tabbar button')].map((b) => b.textContent.trim())));
  window.scrollTo(0, 0);
  await sleep(300);
  return out.join('\n');
})()