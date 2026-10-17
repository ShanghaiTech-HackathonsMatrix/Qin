(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  const go = async (name) => { tabs().find((x) => x.textContent.includes(name))?.click(); await sleep(900); };

  await go('任务');
  const rows = [...document.querySelectorAll('.log-row')].map((r) => ({
    due: (r.querySelector('.log-row__due b')?.textContent || '').trim(),
    day: (r.querySelector('.log-row__due em')?.textContent || '').trim(),
    t: (r.querySelector('.log-row__body strong')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26),
  }));
  out.push('【前 8 条】');
  for (const r of rows.slice(0, 8)) out.push(`  ${r.due.padEnd(11)} ${r.day.padEnd(5)} ${r.t}`);
  out.push('【后 5 条】');
  for (const r of rows.slice(-5)) out.push(`  ${r.due.padEnd(11)} ${r.day.padEnd(5)} ${r.t}`);
  out.push('已提交总数 = ' + rows.filter((r) => r.day === '已提交').length + ' / ' + rows.length);

  await go('日程');
  const heads = [...document.querySelectorAll('.schedule-day__head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim());
  out.push('【日程分组】' + JSON.stringify(heads));
  const groups = [...document.querySelectorAll('.schedule-day')];
  if (groups[0]) out.push('【第一组明细】' + groups[0].textContent.replace(/\s+/g, ' ').trim().slice(0, 220));

  await go('首页');
  out.push('【首页】' + (document.querySelector('.app__body')?.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
  return out.join('\n');
})()