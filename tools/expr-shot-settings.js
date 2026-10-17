(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(700);
  for (const i of [0, 1, 2]) {
    btnHas(document.querySelectorAll('.conn')[i], '同步')?.click();
    await sleep(2000);
  }
  window.scrollTo(0, 0);
  await sleep(400);
  return 'ok';
})()