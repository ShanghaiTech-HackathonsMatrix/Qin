(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  const go = async (name) => {
    const b = tabs().find((x) => x.textContent.includes(name));
    b?.click();
    await sleep(900);
  };

  // 平台状态
  await go('设置');
  const conns = [...document.querySelectorAll('.conn')].map((c) => ({
    平台: (c.querySelector('.conn__title strong')?.textContent || '').trim(),
    状态: (c.querySelector('.conn__badge')?.textContent || c.querySelector('[data-state]')?.textContent || '').trim(),
    备注: (c.querySelector('.conn__note')?.textContent || '').replace(/\s+/g, ' ').trim(),
  }));
  out.push('【平台】' + JSON.stringify(conns, null, 0));

  // 任务日志
  await go('任务');
  const rows = [...document.querySelectorAll('.log-row')].map((r) => ({
    t: (r.querySelector('.log-row__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
    s: (r.querySelector('.log-row__due em')?.textContent || '').trim(),
    d: r.getAttribute('data-done'),
  }));
  out.push('【任务日志 ' + rows.length + ' 条】');
  for (const r of rows) out.push('  ' + r.s + ' | ' + r.t + (r.d === 'true' ? '  [已勾]' : ''));

  // 日程
  await go('日程');
  const heads = [...document.querySelectorAll('.schedule-day__head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim());
  out.push('【日程分组】' + JSON.stringify(heads));
  const first = document.querySelector('.schedule-day');
  out.push('【日程第一组】' + (first?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160));

  // 首页
  await go('首页');
  out.push('【首页】' + (document.querySelector('.app__body')?.innerText || '').replace(/\s+/g, ' ').slice(0, 260));
  return out.join('\n');
})()