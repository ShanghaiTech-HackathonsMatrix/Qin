(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tab = (i) => document.querySelectorAll('.tabbar button')[i].click();
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));

  tab(3);
  await sleep(800);
  for (const i of [0, 1, 2]) {
    btnHas(document.querySelectorAll('.conn')[i], '同步')?.click();
    await sleep(2200);
  }
  out.push('平台状态 = ' + JSON.stringify([...document.querySelectorAll('.conn__status')].map((s) => s.textContent.trim())));

  // 日程：按天分组，看有没有重复与范围
  tab(2);
  await sleep(900);
  const days = [...document.querySelectorAll('.schedule-day')].map((d) => ({
    head: (d.querySelector('.schedule-day__head')?.textContent || '').replace(/\s+/g, ' ').trim(),
    n: d.querySelectorAll('.schedule-entry').length,
  }));
  out.push('日程分组 = ' + JSON.stringify(days));
  out.push('ornament = ' + JSON.stringify([...document.querySelectorAll('.quest-section__ornament')].map((o) => o.textContent.trim())));
  const firstDay = document.querySelector('.schedule-day');
  out.push('第一天条目 = ' + JSON.stringify([...(firstDay?.querySelectorAll('.schedule-entry') ?? [])].map((e) => ({
    t: (e.querySelector('.schedule-entry__time')?.textContent || '').trim(),
    title: (e.querySelector('.schedule-entry__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
    kind: e.dataset.kind,
  }))));

  // 作业详情里的「平台原文」
  tab(1);
  await sleep(800);
  const row = [...document.querySelectorAll('.log-row')].find((r) => r.textContent.includes('线框草图'));
  row?.click();
  await sleep(600);
  const sheet = document.querySelector('.sheet');
  out.push('平台原文 = ' + JSON.stringify([...(sheet?.querySelectorAll('.assign-hint') ?? [])].map((n) => n.textContent.trim())));
  out.push('截止时间输入框 = ' + JSON.stringify(sheet?.querySelector('input[type="datetime-local"]')?.value ?? null));

  // 改截止时间 + 标记完成，看列表是否跟着变
  const box = sheet?.querySelector('input[type="checkbox"]');
  box?.click();
  await sleep(150);
  [...(sheet?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === '保存')?.click();
  await sleep(900);
  const after = [...document.querySelectorAll('.log-row')].map((r) => ({
    title: (r.querySelector('.log-row__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
    done: r.getAttribute('data-overdue'),
  }));
  out.push('保存后列表 = ' + JSON.stringify(after.slice(0, 3)));
  out.push('弹层已关闭 = ' + (document.querySelector('.sheet') === null));

  // 颜色审计
  const seen = new Set();
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    for (const p of ['color', 'backgroundColor', 'borderTopColor']) {
      const v = cs[p];
      if (!v || v === 'rgba(0, 0, 0, 0)' || v === 'none') continue;
      const m = v.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (Math.abs(r - g) > 6 || Math.abs(g - b) > 6 || Math.abs(r - b) > 6) seen.add(v);
    }
  }
  out.push('非黑白灰颜色 = ' + JSON.stringify([...seen]));
  return out.join('\n');
})()