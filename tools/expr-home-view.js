(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pickCard = (name) => [...document.querySelectorAll('.quick__option')].find((b) => b.querySelector('strong')?.textContent === name);

  document.querySelector('.topbar .btn--brush').click();
  await sleep(300);

  document.querySelector('.home-slot--add').click();
  await sleep(300);
  pickCard('本周日程').click();
  await sleep(500);
  document.querySelector('.sheet__head button').click();
  await sleep(300);

  for (const id of ['next-class', 'ddl', 'atlas']) {
    document.querySelector('.home-slot[data-card="' + id + '"]').querySelector('.icon-btn--wide').click();
    await sleep(400);
  }

  const gap = document.querySelectorAll('.home-slot--gap').length;
  // 退出定制：还是顶栏那颗刷子
  document.querySelector('.topbar .btn--brush').click();
  await sleep(400);

  const slots = [...document.querySelectorAll('.home-slot[data-card]')].map((el) => {
    const r = el.getBoundingClientRect();
    return el.dataset.card + ':' + el.dataset.size + ':' + Math.round(r.width) + 'x' + Math.round(r.height);
  });
  return '编辑态空位框=' + gap + ' | 收尾后 ' + slots.join('  ');
})()