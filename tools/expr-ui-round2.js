(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));
  const badge = () => (document.querySelectorAll('.tabbar button')[1].textContent || '').trim();
  const heroNums = () => [...document.querySelectorAll('.quest-intro__stats b')].map((b) => b.textContent).join('/');
  const px = (sel, prop) => {
    const el = document.querySelector(sel);
    if (el === null) return '(无)';
    return getComputedStyle(el)[prop];
  };

  // ---- 结构：加号在人物卡里，浮动按钮没了 ----
  log.push('人物卡里的加号 = ' + (document.querySelector('.quest-intro__add') !== null));
  log.push('右下角浮动按钮 = ' + (document.querySelector('.fab') !== null));
  const addBox = document.querySelector('.quest-intro__add')?.getBoundingClientRect();
  const introBox = document.querySelector('.quest-intro')?.getBoundingClientRect();
  log.push('加号在人物卡范围内 = ' + (addBox !== undefined && introBox !== undefined && addBox.top >= introBox.top - 1 && addBox.bottom <= introBox.bottom + 1));

  // ---- 字号 ----
  log.push('DDL 标题字号 = ' + px('.ddl-card__body strong', 'fontSize'));
  log.push('DDL 时间字号 = ' + px('.ddl-card__time strong', 'fontSize'));

  // ---- 逾期配色 ----
  const overdue = document.querySelector('.ddl-card[data-overdue="true"]');
  if (overdue === null) log.push('逾期卡 = 今天没有逾期条目');
  else {
    const cs = getComputedStyle(overdue);
    log.push('逾期卡 背景=' + cs.backgroundColor + ' 文字=' + cs.color + ' 边框=' + cs.borderTopStyle);
  }

  const before = { badge: badge(), nums: heroNums() };
  log.push('加之前 → ' + before.badge + ' / ' + before.nums);

  // ---- 用人物卡里的加号新建一条 ----
  document.querySelector('.quest-intro__add').click();
  await sleep(350);
  btn('自主添加')?.click();
  await sleep(400);
  setValue(document.querySelector('.sheet input[placeholder*="作业"]'), '加号新建自检');
  await sleep(150);
  btn('保存')?.click();
  await sleep(900);

  log.push('加之后 → ' + badge() + ' / ' + heroNums());

  // ---- 任务日志里应能看见 ----
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(600);
  const rows = [...document.querySelectorAll('.log-row')].map((r) => (r.textContent || '').replace(/\s+/g, ' ').trim());
  log.push('日志里能看见「加号新建自检」= ' + rows.some((r) => r.includes('加号新建自检')));
  log.push('日志行数 = ' + rows.length);
  log.push('日志标题字号 = ' + px('.log-row__body strong', 'fontSize') + ' 截止字号 = ' + px('.log-row__due b', 'fontSize'));

  // ---- 设置页字号滑轨 ----
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(600);
  const range = document.querySelector('.slider input[type="range"]');
  log.push('字号滑轨存在 = ' + (range !== null) + ' 值=' + (range?.value ?? '-'));
  if (range !== null) {
    setValue(range, '1.25');
    await sleep(400);
    document.querySelectorAll('.tabbar button')[1].click();
    await sleep(500);
    log.push('调到 125% 后 日志标题字号 = ' + px('.log-row__body strong', 'fontSize') + ' 截止字号 = ' + px('.log-row__due b', 'fontSize'));
    document.querySelectorAll('.tabbar button')[3].click();
    await sleep(400);
    setValue(document.querySelector('.slider input[type="range"]'), '1');
    await sleep(300);
  }

  return log.join('\n');
})()