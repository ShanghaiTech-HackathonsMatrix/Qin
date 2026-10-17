(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));
  const out = [];

  // 用加号新建一条带截止时间的自建任务
  document.querySelector('.quest-intro__add').click();
  await sleep(350);
  btn('自主添加')?.click();
  await sleep(400);
  setValue(document.querySelector('.sheet input[placeholder*="作业"]'), '自建带时间');
  await sleep(120);

  const kindChip = btn('自定义');
  kindChip?.click();
  await sleep(120);

  const d = new Date();
  d.setHours(22, 45, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  setValue(
    document.querySelector('.sheet input[type="datetime-local"]'),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T22:45`,
  );
  await sleep(150);
  btn('保存')?.click();
  await sleep(900);

  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(700);

  const sections = [...document.querySelectorAll('.quest-section__head h2')].map((h) => h.textContent);
  out.push('小节 = ' + JSON.stringify(sections));
  const rows = [...document.querySelectorAll('.log-row')].map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim());
  out.push('日志行 = ' + JSON.stringify(rows.slice(0, 4)));
  const mine = [...document.querySelectorAll('.log-row')].filter((r) => r.textContent.includes('自建带时间'));
  out.push('自建带时间 出现在 ' + mine.length + ' 行');
  if (mine.length > 0) out.push('  它在的那一行 = ' + (mine[0].textContent || '').replace(/\s+/g, ' ').trim());

  // 首页 DDL 卡有没有它
  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(600);
  const cards = [...document.querySelectorAll('.ddl-card')].map((c) => (c.textContent || '').replace(/\s+/g, ' ').trim());
  out.push('首页 DDL 卡 = ' + JSON.stringify(cards));
  return out.join('\n');
})()