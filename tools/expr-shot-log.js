(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(600);
  for (const i of [0, 1, 2]) {
    btnHas(document.querySelectorAll('.conn')[i], '同步')?.click();
    await sleep(2000);
  }
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(800);
  window.scrollTo(0, 0);
  await sleep(300);
  return 'ok';
})()