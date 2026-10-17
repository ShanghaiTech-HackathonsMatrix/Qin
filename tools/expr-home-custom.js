(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const cards = () => [...document.querySelectorAll('.home-slot[data-card]')].map((e) => e.dataset.card);
  const sizes = () => [...document.querySelectorAll('.home-slot[data-card]')].map((e) => e.dataset.card + ':' + e.dataset.size);
  const grid = () => document.querySelector('.home-grid');

  out.push('初始 = ' + cards().join(','));

  // 冷启动时首页可能还在装配（演示数据 + WASM），先等它把顶栏画出来
  for (let i = 0; i < 40 && document.querySelector('.topbar .btn--brush') === null; i += 1) await sleep(150);

  // 1) 进入定制：顶栏那颗刷子
  document.querySelector('.topbar .btn--brush').click();
  await sleep(400);
  // 拖动栏已经删掉了 —— 这张断言就是钉住「它真的不在了」
  out.push('拖动栏数量 = ' + document.querySelectorAll('.home-slot__bar').length);
  out.push('抓手数量 = ' + document.querySelectorAll('.home-slot__grab').length + ' / 右上角按钮 = ' + document.querySelectorAll('.home-slot__tools').length);
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

  // 3) 下一节课切成半宽（按钮现在浮在卡片右上角）
  document.querySelector('.home-slot[data-card="next-class"]').querySelector('.icon-btn--wide').click();
  await sleep(600);
  out.push('切半宽后 = ' + sizes().join(','));
  out.push('布局模式 = ' + grid().dataset.mode + ' / 滚动 = ' + grid().dataset.scroll);
  const r = document.querySelector('.home-slot[data-card="next-class"]').getBoundingClientRect();
  out.push('半宽卡宽度 = ' + Math.round(r.width));

  // 4) 把第一张卡拖到最后 —— 整张卡都能抓，但要先按住 0.2 秒
  const before = cards();
  const grab = document.querySelectorAll('.home-slot__grab')[0];
  const box = grab.getBoundingClientRect();
  grab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: box.left + 20, clientY: box.top + 20 }));
  await sleep(80);
  out.push('按住 0.08 秒 = ' + (document.querySelector('.home-slot[data-dragging="true"]')?.dataset.card ?? '还没拿起'));
  await sleep(220);   // 累计 0.3 秒，过线
  out.push('按住 0.3 秒 = ' + (document.querySelector('.home-slot[data-dragging="true"]')?.dataset.card ?? '还没拿起'));
  const target = document.querySelector('.home-slot[data-card="ddl"]').getBoundingClientRect();
  window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: target.left + 30, clientY: target.top + 10 }));
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