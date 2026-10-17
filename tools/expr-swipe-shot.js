(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));

  document.querySelector('.quest-intro__add').click();
  await sleep(320);
  btn('自主添加')?.click();
  await sleep(380);
  setValue(document.querySelector('.sheet input[placeholder*="作业"]'), '自建：读书笔记');
  await sleep(120);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  setValue(
    document.querySelector('.sheet input[type="datetime-local"]'),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T23:30`,
  );
  await sleep(150);
  btn('保存')?.click();
  await sleep(850);

  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(700);

  // 把「自建：读书笔记」那一行滑开，截图里就能看到编辑/删除
  const row = [...document.querySelectorAll('.log-row')].find((r) => r.textContent.includes('自建：读书笔记'));
  const surface = row?.closest('.swipe')?.querySelector('.swipe__surface');
  if (surface !== undefined && surface !== null) {
    const r = surface.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (type, x) => surface.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'touch',
    }));
    fire('pointerdown', r.right - 20);
    await sleep(30);
    fire('pointermove', r.right - 70);
    await sleep(30);
    fire('pointermove', r.right - 120);
    await sleep(30);
    fire('pointerup', r.right - 120);
    await sleep(400);
  }
  return 'swiped';
})()