(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  const go = async (n) => { tabs().find((b) => b.textContent.includes(n))?.click(); await sleep(800); };
  const out = [];
  await go('设置');
  for (const i of [0, 1, 2]) {
    [...document.querySelectorAll('.conn')][i].querySelectorAll('button')[0]?.click();
    await sleep(1800);
  }
  await go('首页');
  out.push('首页统计 = ' + [...document.querySelectorAll('.quest-intro__stats span')].map((s) => s.textContent.trim()).join(' / '));
  out.push('任务 tab = ' + tabs()[1].textContent.trim());
  await go('任务');
  const rows = [...document.querySelectorAll('.log-row')].map((r) => ({
    s: (r.querySelector('.log-row__due em')?.textContent || '').trim(),
    t: (r.querySelector('.log-row__body strong')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22),
  }));
  out.push('前 6 条 = ' + JSON.stringify(rows.slice(0, 6).map((r) => r.s + ':' + r.t)));
  out.push('后 4 条 = ' + JSON.stringify(rows.slice(-4).map((r) => r.s + ':' + r.t)));
  const firstDone = rows.findIndex((r) => r.s === '已提交' || r.s === '已完成');
  const lastUndone = rows.map((r) => r.s).lastIndexOf('已逾期');
  out.push('第一条已提交位置 = ' + firstDone + '，最后一条已逾期位置 = ' + lastUndone + ' -> ' + (firstDone > lastUndone ? '已提交都在后面 OK' : '顺序不对'));
  return out.join('\n');
})()