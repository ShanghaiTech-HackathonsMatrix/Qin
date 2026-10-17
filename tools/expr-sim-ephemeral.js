(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));
  const out = [];
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(700);
  out.push('进来时 = ' + JSON.stringify([...document.querySelectorAll('.conn__status')].map((s) => s.textContent.trim())));
  for (const i of [0, 1, 2]) {
    btnHas(document.querySelectorAll('.conn')[i], '同步')?.click();
    await sleep(2000);
  }
  out.push('同步后 = ' + JSON.stringify([...document.querySelectorAll('.conn__status')].map((s) => s.textContent.trim())));
  out.push('模拟提示 = ' + JSON.stringify([...document.querySelectorAll('.conn-grid > .conn__note')].map((n) => n.textContent.trim())));
  return out.join('\n');
})()