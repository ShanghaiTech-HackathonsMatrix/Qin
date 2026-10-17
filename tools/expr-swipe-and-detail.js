(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const btn = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.includes(t));
  const out = [];

  // 1) 新建一条自建任务（带时间）
  document.querySelector('.quest-intro__add').click();
  await sleep(320);
  btn('自主添加')?.click();
  await sleep(380);
  setValue(document.querySelector('.sheet input[placeholder*="作业"]'), '自建详情自检');
  await sleep(120);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  setValue(
    document.querySelector('.sheet input[type="datetime-local"]'),
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T23:20`,
  );
  await sleep(150);
  btn('保存')?.click();
  await sleep(850);

  // 2) 点它，应该打开编辑表单而不是演示详情抽屉
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(700);
  const row = [...document.querySelectorAll('.log-row')].find((r) => r.textContent.includes('自建详情自检'));
  out.push('找到这一行 = ' + (row !== undefined));
  row?.click();
  await sleep(600);
  const sheetTitle = (document.querySelector('.sheet input[placeholder*="作业"]')?.value) ?? '(没打开编辑表单)';
  out.push('点开后编辑表单标题 = ' + sheetTitle);
  out.push('是否误开演示抽屉 = ' + (document.querySelector('.ddl-detail') !== null));
  btn('取消')?.click();
  await sleep(400);

  // 3) 左滑
  const surface = row?.closest('.swipe')?.querySelector('.swipe__surface');
  const swipe = row?.closest('.swipe');
  out.push('包了 swipe 容器 = ' + (swipe !== undefined && swipe !== null));
  out.push('操作按钮 = ' + JSON.stringify([...(swipe?.querySelectorAll('.swipe__action') ?? [])].map((b) => b.textContent)));

  if (surface !== undefined && surface !== null) {
    const r = surface.getBoundingClientRect();
    const y = r.top + r.height / 2;
    const fire = (type, x, extra = {}) => surface.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'touch', ...extra,
    }));
    fire('pointerdown', r.right - 20);
    await sleep(30);
    fire('pointermove', r.right - 60);
    await sleep(30);
    fire('pointermove', r.right - 110);
    await sleep(30);
    fire('pointerup', r.right - 110);
    await sleep(400);
    const after = surface.getBoundingClientRect();
    out.push('滑开后位移 = ' + Math.round(after.left - r.left) + 'px  data-open=' + swipe?.dataset.open);
  }

  // 4) 点删除
  const del = [...(swipe?.querySelectorAll('.swipe__action') ?? [])].find((b) => b.textContent === '删除');
  out.push('有删除按钮 = ' + (del !== undefined));
  del?.click();
  await sleep(800);
  const stillThere = [...document.querySelectorAll('.log-row')].some((r) => r.textContent.includes('自建详情自检'));
  out.push('删除后还在吗 = ' + stillThere);

  // 5) 底部栏
  const tabs = [...document.querySelectorAll('.tabbar button')].map((b) => ({
    icon: b.querySelector('svg') !== null,
    label: b.textContent.trim(),
    fs: getComputedStyle(b).fontSize,
    color: getComputedStyle(b).color,
    active: b.dataset.active,
  }));
  out.push('底部栏 = ' + JSON.stringify(tabs));
  return out.join('\n');
})()