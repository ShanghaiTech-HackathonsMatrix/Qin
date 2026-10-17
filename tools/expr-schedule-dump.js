(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabbar button')[2].click();
  await sleep(800);
  return [...document.querySelectorAll('.schedule-day')].map((d) => {
    const head = (d.querySelector('.schedule-day__head')?.textContent || '').replace(/\s+/g, ' ').trim();
    const rows = [...d.querySelectorAll('.schedule-entry')].map((e) => {
      const t = (e.querySelector('.schedule-entry__time')?.textContent || '').trim();
      const title = (e.querySelector('.schedule-entry__body strong')?.textContent || '').replace(/\s+/g, ' ').trim();
      return t + ' ' + title + ' [' + e.dataset.kind + ']';
    });
    return head + '\n    ' + rows.join('\n    ');
  }).join('\n');
})()