(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const cards = [...document.querySelectorAll('.home-slot[data-card]')].map((el) => el.dataset.card + ':' + el.dataset.size);
  log.push('首页卡片 = ' + cards.join(','));
  log.push('DDL 卡 = ' + JSON.stringify([...document.querySelectorAll('.ddl-card')].map((c) => c.textContent.replace(/\s+/g, ' ').trim())));

  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(600);
  log.push('日志条数 = ' + document.querySelectorAll('.log-row').length);
  log.push('表头 = ' + (document.querySelector('.quest-section__ornament')?.textContent || '').trim());
  log.push('插件折叠区(演示应=0) = ' + document.querySelectorAll('.plugin-page').length);

  const first = document.querySelector('.log-row');
  first?.click();
  await sleep(500);
  const overlay = document.querySelector('.ddl-detail, .demo-overlay, .sheet');
  log.push('点开详情 = ' + (overlay === null ? '(无)' : overlay.className));
  log.push('详情文本 = ' + (overlay?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90));
  return log.join('\n');
})()