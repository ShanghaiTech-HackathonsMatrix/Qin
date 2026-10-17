(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(800);
  const grid = document.querySelector('.conn-grid');
  out.push('顶部提示 = ' + JSON.stringify([...grid.querySelectorAll(':scope > .conn__note')].map((n) => n.textContent.trim())));
  out.push('按钮 = ' + JSON.stringify([...grid.querySelectorAll('.conn__actions button')].map((b) => b.textContent.trim() + (b.disabled ? '(禁用)' : '(可用)'))));
  out.push('状态徽标 = ' + JSON.stringify([...document.querySelectorAll('.conn__status')].map((s) => s.textContent.trim())));
  return out.join('\n');
})()