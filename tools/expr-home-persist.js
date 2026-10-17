(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 恢复默认，再从干净状态开始
  [...document.querySelectorAll('.topbar button')].find((b) => b.textContent.trim() === '定制').click();
  await sleep(300);
  document.querySelector('.home-slot--add').click();
  await sleep(300);
  [...document.querySelectorAll('.sheet button')].find((b) => b.textContent.trim() === '恢复默认排布').click();
  await sleep(500);
  document.querySelector('.sheet__head button').click();
  await sleep(300);

  // 加「本周日程」，并把「下一节课」切成半宽
  document.querySelector('.home-slot--add').click();
  await sleep(300);
  [...document.querySelectorAll('.quick__option')].find((b) => b.querySelector('strong').textContent === '本周日程').click();
  await sleep(500);
  document.querySelector('.sheet__head button').click();
  await sleep(300);
  const idx = [...document.querySelectorAll('.home-slot[data-card]')].findIndex((e) => e.dataset.card === 'next-class');
  [...document.querySelectorAll('.home-slot__bar')][idx].querySelector('.icon-btn--wide').click();
  await sleep(500);
  [...document.querySelectorAll('.topbar button')].find((b) => b.textContent.trim() === '完成').click();
  await sleep(300);

  const snap = () => {
    const grid = document.querySelector('.home-grid');
    const slots = [...document.querySelectorAll('.home-slot[data-card]')].map((el) => {
      const r = el.getBoundingClientRect();
      return el.dataset.card + ':' + el.dataset.size + ':' + Math.round(r.width) + 'x' + Math.round(r.height);
    });
    return {
      mode: grid.dataset.mode,
      scroll: grid.dataset.scroll,
      slots,
      week: document.querySelectorAll('.week-day').length + '列/' + document.querySelectorAll('.week-day__mark').length + '杠',
      saved: JSON.parse(localStorage.getItem('CapacitorStorage.matrix_app.settings') || '{}').homeCards,
    };
  };
  return '改完：' + JSON.stringify(snap());
})()
/* ---RELOAD--- */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(600);
  const grid = document.querySelector('.home-grid');
  const slots = [...document.querySelectorAll('.home-slot[data-card]')].map((el) => {
    const r = el.getBoundingClientRect();
    return el.dataset.card + ':' + el.dataset.size + ':' + Math.round(r.width) + 'x' + Math.round(r.height);
  });
  return '刷新后：' + JSON.stringify({
    mode: grid.dataset.mode,
    scroll: grid.dataset.scroll,
    slots,
    week: document.querySelectorAll('.week-day').length + '列/' + document.querySelectorAll('.week-day__mark').length + '杠',
    bodyFits: (() => { const b = document.querySelector('.app__body'); return b.scrollHeight <= b.clientHeight + 1; })(),
  });
})()