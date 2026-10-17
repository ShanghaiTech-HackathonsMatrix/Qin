(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const dump = (label) => {
    const sheet = document.querySelector('.sheet');
    log.push(label + ' → sheet=' + (sheet !== null));
    if (sheet !== null) {
      log.push('  buttons: ' + [...sheet.querySelectorAll('button')].map((b) => b.textContent.trim()).join(' | '));
      log.push('  inputs: ' + [...sheet.querySelectorAll('input,textarea')].map((i) => i.type + '/' + (i.placeholder || '')).join(' | '));
    }
  };

  document.querySelector('.fab')?.click();
  await sleep(400);
  dump('FAB 之后');

  const manual = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('自主添加'));
  log.push('找到自主添加 = ' + (manual !== undefined));
  manual?.click();
  await sleep(500);
  dump('自主添加之后');
  log.push('class=editor 数量 = ' + document.querySelectorAll('.editor').length);
  return log.join('\n');
})()