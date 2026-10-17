(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => document.querySelectorAll('.tabbar button');

  // 1) 任务日志：来自平台的 DDL
  tabs()[1].click();
  await sleep(600);
  const rows = [...document.querySelectorAll('.log-row')];
  out.push('log rows = ' + rows.length);
  out.push('first row = ' + (rows[0]?.textContent || '').replace(/\s+/g, ' ').trim());

  // 2) 点一条看详情
  rows[0].click();
  await sleep(500);
  const detail = document.querySelector('.ddl-detail');
  out.push('detail open = ' + (detail !== null));
  out.push('detail title = ' + (document.querySelector('.ddl-detail__title')?.textContent ?? '-'));
  document.querySelector('.ddl-detail__close').click();
  await sleep(300);
  out.push('detail closed = ' + (document.querySelector('.ddl-detail') === null));

  // 3) 右下角加号
  const fab = document.querySelector('.fab');
  out.push('fab = ' + JSON.stringify(fab ? [Math.round(fab.getBoundingClientRect().width), getComputedStyle(fab).backgroundColor, getComputedStyle(fab).borderRadius] : null));
  fab.click();
  await sleep(400);
  out.push('quick options = ' + [...document.querySelectorAll('.quick__option strong')].map((e) => e.textContent).join(' / '));

  // 4) 导入文字
  [...document.querySelectorAll('.quick__option')][0].click();
  await sleep(400);
  const ta = document.querySelector('.quick__input');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '算法设计 第三次作业 周五交\n读完《交互设计》第三章\n预约图书馆研讨室');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(300);
  out.push('count line = ' + document.querySelector('.quick__count').textContent.replace(/\s+/g, ' ').trim());

  const addBtn = [...document.querySelectorAll('.quick button')].find((b) => b.textContent.trim() === '按行添加');
  addBtn.click();
  await sleep(800);
  out.push('after add: sections = ' + [...document.querySelectorAll('.quest-section__head h2')].map((h) => h.textContent).join(' / '));
  out.push('self rows = ' + document.querySelectorAll('.log-row[data-static="true"]').length);
  out.push('toast = ' + (document.querySelector('.toast')?.textContent ?? '(none)'));
  return out.join('\n');
})()