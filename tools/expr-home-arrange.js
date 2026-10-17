(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const pickCard = (name) => [...document.querySelectorAll('.quick__option')].find((b) => b.querySelector('strong')?.textContent === name);

  pick('定制').click();
  await sleep(300);

  // 加「本周日程」
  document.querySelector('.home-slot--add').click();
  await sleep(300);
  pickCard('本周日程').click();
  await sleep(500);
  document.querySelector('.sheet__head button').click();
  await sleep(300);

  // 「下一节课」和「最近的 DDL」并排成半宽
  for (const id of ['next-class', 'ddl']) {
    const idx = [...document.querySelectorAll('.home-slot[data-card]')].findIndex((e) => e.dataset.card === id);
    [...document.querySelectorAll('.home-slot__bar')][idx].querySelector('.icon-btn--wide').click();
    await sleep(400);
  }

  // 「冒险图鉴」也切半宽，让它跟后面那张并排
  const idxAtlas = [...document.querySelectorAll('.home-slot[data-card]')].findIndex((e) => e.dataset.card === 'atlas');
  [...document.querySelectorAll('.home-slot__bar')][idxAtlas].querySelector('.icon-btn--wide').click();
  await sleep(400);

  const slots = [...document.querySelectorAll('.home-slot[data-card]')].map((el) => {
    const r = el.getBoundingClientRect();
    return el.dataset.card + ':' + el.dataset.size + ':' + Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top);
  });
  return slots.join('  ');
})()