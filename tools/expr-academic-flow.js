(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tab = (i) => document.querySelectorAll('.tabbar button')[i].click();
  const btnIn = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));

  // 1) 设置页 → 平台连接
  tab(3);
  await sleep(900);
  const conns = [...document.querySelectorAll('.conn')].map((c) => ({
    title: (c.querySelector('.conn__title strong')?.textContent || '').trim(),
    status: (c.querySelector('.conn__status')?.textContent || '').trim(),
    notes: [...c.querySelectorAll('.conn__note')].map((n) => n.textContent.trim()).slice(0, 2),
    buttons: [...c.querySelectorAll('button')].map((b) => b.textContent.trim() + (b.disabled ? '(禁用)' : '')),
  }));
  out.push('平台连接块 = ' + JSON.stringify(conns, null, 1));

  // 2) 同步 Gradescope
  const first = document.querySelectorAll('.conn')[0];
  btnHas(first, '同步')?.click();
  await sleep(2500);
  const after = [...document.querySelectorAll('.conn')][0];
  out.push('同步后状态 = ' + (after.querySelector('.conn__status')?.textContent || '').trim());
  out.push('同步后提示 = ' + JSON.stringify([...after.querySelectorAll('.conn__note')].map((n) => n.textContent.trim())));

  // 3) 同步 Blackboard 与教务
  for (const i of [1, 2]) {
    const block = document.querySelectorAll('.conn')[i];
    btnHas(block, '同步')?.click();
    await sleep(2200);
  }
  out.push('三个平台状态 = ' + JSON.stringify([...document.querySelectorAll('.conn__status')].map((s) => s.textContent.trim())));

  // 4) 任务日志
  tab(1);
  await sleep(900);
  const rows = [...document.querySelectorAll('.log-row')].map((r) => ({
    due: (r.querySelector('.log-row__due b')?.textContent || '').trim(),
    title: (r.querySelector('.log-row__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
    meta: (r.querySelector('.log-row__body small')?.textContent || '').trim(),
  }));
  out.push('任务日志 = ' + JSON.stringify(rows, null, 1));
  out.push('是否按时间升序 = ' + rows.every((r, i, a) => i === 0 || a[i - 1].due <= r.due));

  // 5) 点开一条平台作业
  const target = [...document.querySelectorAll('.log-row')].find((r) => r.textContent.includes('线框草图'));
  target?.click();
  await sleep(700);
  const sheet = document.querySelector('.sheet');
  out.push('作业详情标题 = ' + JSON.stringify((sheet?.querySelector('input.field')?.value) ?? '(没打开)'));
  out.push('弹层里的平台原文 = ' + JSON.stringify([...(sheet?.querySelectorAll('.assign-hint') ?? [])].map((n) => n.textContent.trim())));
  out.push('弹层按钮 = ' + JSON.stringify([...(sheet?.querySelectorAll('button') ?? [])].map((b) => b.textContent.trim())));
  [...(sheet?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === '关闭')?.click();
  await sleep(400);

  // 6) 日程页有没有重复
  tab(2);
  await sleep(900);
  const entries = [...document.querySelectorAll('.schedule-entry')].map((e) => ({
    time: (e.querySelector('.schedule-entry__time')?.textContent || '').trim(),
    title: (e.querySelector('.schedule-entry__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
    kind: e.dataset.kind,
  }));
  const dupes = entries.filter((e, i) => entries.findIndex((x) => x.title === e.title && x.time === e.time) !== i);
  out.push('日程条目数 = ' + entries.length + ' 重复 = ' + dupes.length);
  out.push('日程前 6 条 = ' + JSON.stringify(entries.slice(0, 6)));

  // 7) 首页 DDL
  tab(0);
  await sleep(800);
  const cards = [...document.querySelectorAll('.ddl-card')].map((c) => ({
    time: (c.querySelector('.ddl-card__time strong')?.textContent || '').trim(),
    title: (c.querySelector('.ddl-card__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
    meta: (c.querySelector('.ddl-card__body small')?.textContent || '').trim(),
  }));
  out.push('首页 DDL = ' + JSON.stringify(cards, null, 1));
  return out.join('\n');
})()