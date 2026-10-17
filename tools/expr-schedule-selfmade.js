(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));

  // 新建两条自建 DDL：一条今天 23:10，一条今天 23:40
  const add = async (title, hh, mm) => {
    document.querySelectorAll('.tabbar button')[0].click();
    await sleep(300);
    document.querySelector('.quest-intro__add').click();
    await sleep(300);
    btn('自主添加')?.click();
    await sleep(350);
    setValue(document.querySelector('.sheet input[placeholder*="作业"]'), title);
    await sleep(120);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    setValue(
      document.querySelector('.sheet input[type="datetime-local"]'),
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hh}:${mm}`,
    );
    await sleep(150);
    btn('保存')?.click();
    await sleep(800);
  };
  await add('自建甲 23:40', '23', '40');
  await add('自建乙 23:10', '23', '10');

  document.querySelectorAll('.tabbar button')[2].click();
  await sleep(800);

  const days = [...document.querySelectorAll('.schedule-day')].map((d) => ({
    head: (d.querySelector('.schedule-day__head')?.textContent || '').replace(/\s+/g, ' ').trim(),
    rows: [...d.querySelectorAll('.schedule-entry')].map((e) => ({
      time: (e.querySelector('.schedule-entry__time')?.textContent || '').trim(),
      title: (e.querySelector('.schedule-entry__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
      tag: (e.querySelector('.schedule-entry__tag')?.textContent || '').trim(),
      kind: e.dataset.kind,
    })),
  }));

  const today = days.find((d) => d.head.includes('今天'));
  return '今天这一天：' + (today === undefined ? '(没有今天分组)' : '')
    + (today === undefined ? '' : '\n' + today.rows.map((r) => `  ${r.time}  ${r.title}  [${r.tag}] kind=${r.kind}`).join('\n'))
    + '\n总天数=' + days.length + ' 总条目=' + days.reduce((n, d) => n + d.rows.length, 0)
    + '\n时间是否升序 = ' + (today === undefined ? '-' : today.rows.every((r, i, a) => i === 0 || a[i - 1].time <= r.time));
})()