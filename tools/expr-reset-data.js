(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(800);
  // confirm() 在无头里会阻塞，先换掉
  window.confirm = () => true;
  const reset = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('清空'));
  if (reset === undefined) return '找不到清空按钮：' + JSON.stringify([...document.querySelectorAll('button')].map((b) => b.textContent.trim()));
  reset.click();
  await sleep(2500);
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(700);
  return '清空后状态 = ' + JSON.stringify([...document.querySelectorAll('.conn')].map((c) => ({
    title: (c.querySelector('.conn__title strong')?.textContent || '').trim(),
    status: (c.querySelector('.conn__status')?.textContent || '').trim(),
    notes: [...c.querySelectorAll('.conn__note')].map((n) => n.textContent.trim()).slice(0, 2),
  })), null, 1);
})()