(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];

  // 任务页：点第 2 条平台 DDL，详情标题应该跟着变
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(700);
  const rows = [...document.querySelectorAll('.log-row')];
  const titles = rows.map((r) => (r.querySelector('.log-row__body strong')?.textContent || '').trim());
  out.push('列表标题 = ' + JSON.stringify(titles.slice(0, 4)));

  const second = rows[1];
  const expect = titles[1]?.replace(/自建$/, '').trim();
  second?.click();
  await sleep(600);
  const detail = document.querySelector('.ddl-detail');
  if (detail === null) out.push('第 2 条 → 不是演示抽屉（可能是编辑表单）= ' + (document.querySelector('.sheet') !== null));
  else {
    const got = (detail.querySelector('h2, .ddl-detail__title, strong')?.textContent || '').replace(/\s+/g, ' ').trim();
    out.push('第 2 条详情标题 = ' + got);
    out.push('与列表第 2 条一致 = ' + (expect === undefined ? '-' : got.includes(expect)));
  }
  document.querySelector('.ddl-detail-backdrop')?.click();
  await sleep(400);

  // 第 3 条
  const rows2 = [...document.querySelectorAll('.log-row')];
  const expect3 = (rows2[2]?.querySelector('.log-row__body strong')?.textContent || '').replace(/自建$/, '').trim();
  rows2[2]?.click();
  await sleep(600);
  const d3 = document.querySelector('.ddl-detail');
  if (d3 !== null) {
    const got3 = (d3.querySelector('h2, .ddl-detail__title, strong')?.textContent || '').replace(/\s+/g, ' ').trim();
    out.push('第 3 条详情标题 = ' + got3 + '  与列表一致 = ' + (got3.includes(expect3)));
  } else out.push('第 3 条 → 不是演示抽屉');
  document.querySelector('.ddl-detail-backdrop')?.click();
  await sleep(300);

  // 首页 DDL 卡
  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(600);
  const card = document.querySelector('.ddl-card');
  const cardTitle = (card?.querySelector('.ddl-card__body strong')?.textContent || '').trim();
  card?.click();
  await sleep(600);
  const home = document.querySelector('.ddl-detail') !== null
    ? (document.querySelector('.ddl-detail')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)
    : '(编辑表单或没打开)';
  out.push('首页卡「' + cardTitle + '」→ ' + home);
  return out.join('\n');
})()