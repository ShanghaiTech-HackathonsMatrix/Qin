(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(700);
  const first = document.querySelectorAll('.conn')[0];
  const btns = [...first.querySelectorAll('.conn__actions button')];
  out.push('按钮状态 = ' + JSON.stringify(btns.map((b) => b.textContent.trim() + (b.disabled ? '(禁用)' : '(可用)'))));
  btns.find((b) => b.textContent.includes('登录'))?.click();
  await sleep(2500);
  out.push('点登录后状态 = ' + JSON.stringify([...document.querySelectorAll('.conn__status')].map((s) => s.textContent.trim())));
  out.push('提示 = ' + JSON.stringify([...document.querySelectorAll('.conn__note')].map((n) => n.textContent.trim())));
  out.push('有没有出现新窗口/弹层 = ' + (document.querySelector('.sheet') !== null) + ' / 新标签 ' + (window.open.length > 0));
  return out.join('\n');
})()