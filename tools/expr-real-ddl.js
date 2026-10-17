(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text));

  // 1) 用右下角 FAB 新建一条真实 DDL
  const fab = document.querySelector('.fab');
  if (fab === null) return 'FAIL: 找不到 FAB';
  fab.click();
  await sleep(400);

  const manual = btn('自主添加');
  if (manual === undefined) return 'FAIL: 找不到「自主添加」';
  manual.click();
  await sleep(400);

  const title = document.querySelector('.sheet input[placeholder*="作业"]');
  if (title === null) return 'FAIL: 找不到标题输入框';
  setValue(title, '真实 DDL 接入自检');
  await sleep(150);

  const due = document.querySelector('.sheet input[type="datetime-local"]');
  if (due === null) return 'FAIL: 找不到截止时间输入框';
  const d = new Date();
  d.setHours(23, 30, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  setValue(due, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T23:30`);
  await sleep(150);

  const save = btn('保存');
  if (save === undefined) return 'FAIL: 找不到保存';
  save.click();
  await sleep(1000);

  // 2) 任务页应把它列进日志
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(600);
  const rows = [...document.querySelectorAll('.log-row')].map((r) => ({
    due: (r.querySelector('.log-row__due')?.textContent || '').replace(/\s+/g, ' ').trim(),
    body: (r.querySelector('.log-row__body')?.textContent || '').replace(/\s+/g, ' ').trim(),
  }));
  log.push('任务日志条数 = ' + rows.length);
  rows.slice(0, 3).forEach((r) => log.push('  [' + r.due + '] ' + r.body));

  const head = (document.querySelector('.quest-section__ornament')?.textContent || '').trim();
  log.push('表头 = ' + head);
  log.push('插件折叠区 = ' + document.querySelectorAll('.plugin-page').length);

  // 3) 点第一条应打开编辑表单（不是演示抽屉）
  const first = document.querySelector('.log-row');
  if (first !== null) {
    first.click();
    await sleep(500);
    log.push('点开后是编辑表单 = ' + (document.querySelector('.sheet') !== null));
    const close = btn('取消') || btn('关闭');
    if (close !== undefined) close.click();
    await sleep(300);
  }

  // 4) 回首页看 DDL 卡
  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(600);
  const cards = [...document.querySelectorAll('.home-slot[data-card]')].map((el) => el.dataset.card);
  log.push('首页卡片 = ' + cards.join(','));
  const ddlCard = [...document.querySelectorAll('.ddl-card')].map((c) => c.textContent.replace(/\s+/g, ' ').trim());
  log.push('首页 DDL 卡 = ' + JSON.stringify(ddlCard));
  const atlas = (document.querySelector('.home-slot[data-card="atlas"]')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  log.push('图鉴卡 = ' + (atlas || '(未添加)'));

  return log.join('\n');
})()