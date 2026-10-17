(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const pickCard = (name) => [...document.querySelectorAll('.quick__option')].find((b) => b.querySelector('strong')?.textContent === name);

  pick('定制').click();
  await sleep(300);

  document.querySelector('.home-slot--add').click();
  await sleep(300);
  pickCard('本周日程').click();
  await sleep(500);
  document.querySelector('.sheet__head button').click();
  await sleep(300);

  for (const id of ['next-class', 'ddl', 'atlas']) {
    const idx = [...document.querySelectorAll('.home-slot[data-card]')].findIndex((e) => e.dataset.card === id);
    [...document.querySelectorAll('.home-slot__bar')][idx].querySelector('.icon-btn--wide').click();
    await sleep(400);
  }

  const gap = document.querySelectorAll('.home-slot--gap').length;
  pick('完成').click();
  await sleep(400);

  const slots = [...document.querySelectorAll('.home-slot[data-card]')].map((el) => {
    const r = el.getBoundingClientRect();
    return el.dataset.card + ':' + el.dataset.size + ':' + Math.round(r.width) + 'x' + Math.round(r.height);
  });
  return '编辑态空位框=' + gap + ' | 收尾后 ' + slots.join('  ');
})()