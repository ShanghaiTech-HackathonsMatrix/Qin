(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const stamp = String(Date.now()).slice(-6);

  document.querySelector('.fab').click();
  await sleep(400);
  [...document.querySelectorAll('.quick__option')][0].click();
  await sleep(400);

  const ta = document.querySelector('.quick__input');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    .call(ta, `真实写入自检 ${stamp} A\n真实写入自检 ${stamp} B`);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);

  [...document.querySelectorAll('.quick button')].find((b) => b.textContent.trim() === '按行添加').click();
  await sleep(1500);

  out.push('toast = ' + (document.querySelector('.toast')?.textContent ?? '(none)'));
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(900);
  out.push('task tab text = ' + (document.querySelector('#root').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200));
  out.push('stamp = ' + stamp);
  return out.join('\n');
})()