(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const cards = () => [...document.querySelectorAll('.home-slot[data-card]')].map((e) => e.dataset.card);
  const sizes = () => [...document.querySelectorAll('.home-slot[data-card]')].map((e) => e.dataset.card + ':' + e.dataset.size);
  const grid = () => document.querySelector('.home-grid');

  out.push('初始 = ' + cards().join(','));

  // 1) 进入定制
  [...document.querySelectorAll('.topbar button')].find((b) => b.textContent.trim() === '定制').click();
  await sleep(400);
  out.push('编辑栏数量 = ' + document.querySelectorAll('.home-slot__bar').length);
  out.push('添加按钮 = ' + (document.querySelector('.home-slot--add')?.textContent.trim() ?? '无'));

  // 2) 添加「本周日程」
  document.querySelector('.home-slot--add').click();
  await sleep(400);
  const opts = [...document.querySelectorAll('.quick__option')].map((b) => b.querySelector('strong').textContent + (b.dataset.on === 'true' ? '(已加)' : ''));
  out.push('可选卡片 = ' + opts.join(' / '));
  [...document.querySelectorAll('.quick__option')].find((b) => b.querySelector('strong').textContent === '本周日程').click();
  await sleep(600);
  document.querySelector('.sheet__head button').click();
  await sleep(300);
  out.push('加完 = ' + cards().join(','));
  out.push('周格子 = ' + document.querySelectorAll('.week-day').length + ' 列, 横杠 ' + document.querySelectorAll('.week-day__mark').length + ' 道');
  out.push('今天列 = ' + (document.querySelector('.week-day[data-today="true"]')?.getAttribute('aria-label') ?? '无'));

  // 3) 下一节课切成半宽
  const idxNext = [...document.querySelectorAll('.home-slot[data-card]')].findIndex((e) => e.dataset.card === 'next-class');
  [...document.querySelectorAll('.home-slot__bar')][idxNext]
    .querySelector('.icon-btn--wide').click();
  await sleep(600);
  out.push('切半宽后 = ' + sizes().join(','));
  out.push('布局模式 = ' + grid().dataset.mode + ' / 滚动 = ' + grid().dataset.scroll);
  const r = document.querySelector('.home-slot[data-card="next-class"]').getBoundingClientRect();
  out.push('半宽卡宽度 = ' + Math.round(r.width));

  // 4) 把「最近的 DDL」拖到最前面
  const before = cards();
  const handle = [...document.querySelectorAll('.home-slot__bar')][0].querySelector('.home-slot__handle');
  handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 30, clientY: 200 }));
  await sleep(150);
  const target = document.querySelector('.home-slot[data-card="ddl"]').getBoundingClientRect();
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 30, clientY: target.top + 10 }));
  await sleep(400);
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await sleep(500);
  out.push('拖动前 = ' + before.join(','));
  out.push('拖动后 = ' + cards().join(','));

  // 5) 存盘
  const saved = JSON.parse(localStorage.getItem('CapacitorStorage.matrix_app.settings') || '{}');
  out.push('已存 = ' + JSON.stringify(saved.homeCards));
  return out.join('\n');
})()