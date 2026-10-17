(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  const tab = () => (document.querySelectorAll('.tabbar button')[1].textContent || '').trim();
  const heroNum = () => {
    const el = document.querySelector('.quest-stats b, .hero__stats b');
    return el === null ? '(找不到)' : el.textContent;
  };
  const snapshot = (label) => {
    log.push(label + ' → 任务页签="' + tab() + '"  首页待办=' + heroNum());
  };

  snapshot('加之前');

  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(400);
  document.querySelector('.fab')?.click();
  await sleep(350);
  btn('自主添加')?.click();
  await sleep(400);
  const title = document.querySelector('.sheet input[placeholder*="作业"]');
  setValue(title, '演示模式自检 ' + Date.now());
  await sleep(150);
  btn('保存')?.click();
  await sleep(900);

  snapshot('加之后');
  const rows = [...document.querySelectorAll('.log-row')].map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim());
  log.push('任务日志里能看见这条吗 = ' + rows.some((r) => r.includes('演示模式自检')));
  log.push('日志条数 = ' + rows.length);

  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(500);
  snapshot('回首页');
  return log.join('\n');
})()