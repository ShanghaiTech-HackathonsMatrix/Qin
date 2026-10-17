(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));

  document.querySelector('.quest-intro__add').click();
  await sleep(350);
  btn('自主添加')?.click();
  await sleep(400);
  setValue(document.querySelector('.sheet input[placeholder*="作业"]'), '课程类带时间');
  await sleep(120);
  btn('课程')?.click();
  await sleep(120);
  const d = new Date();
  d.setDate(d.getDate() + 2);
  const pad = (n) => String(n).padStart(2, '0');
  setValue(
    document.querySelector('.sheet input[type="datetime-local"]'),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`,
  );
  await sleep(150);
  btn('保存')?.click();
  await sleep(900);

  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(700);
  const rows = [...document.querySelectorAll('.log-row')].map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim());
  const hit = rows.filter((r) => r.includes('课程类带时间'));
  return '小节 = ' + JSON.stringify([...document.querySelectorAll('.quest-section__head h2')].map((h) => h.textContent))
    + '\n命中行 = ' + JSON.stringify(hit)
    + '\n(期望：出现在「自建任务」段，且显示 09:00 而不是「无期限」)';
})()