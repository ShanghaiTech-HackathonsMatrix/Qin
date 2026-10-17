(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tab = (i) => document.querySelectorAll('.tabbar button')[i].click();
  const btnHas = (root, text) => [...root.querySelectorAll('button')].find((b) => b.textContent.includes(text));

  // 同步三个平台，拿到带「已提交」的数据
  tab(3);
  await sleep(700);
  for (const i of [0, 1, 2]) {
    btnHas(document.querySelectorAll('.conn')[i], '同步')?.click();
    await sleep(2000);
  }

  // ① 日程：第一天必须是今天
  tab(2);
  await sleep(900);
  const heads = [...document.querySelectorAll('.schedule-day__head')].map((h) => h.textContent.replace(/\s+/g, ' ').trim());
  out.push('① 日程分组 = ' + JSON.stringify(heads));
  out.push('   有没有「昨天」= ' + heads.some((h) => h.includes('昨天')));

  // ② 任务日志里的已提交
  tab(1);
  await sleep(900);
  const rows = [...document.querySelectorAll('.log-row')].map((r) => ({
    title: (r.querySelector('.log-row__body strong')?.textContent || '').replace(/\s+/g, ' ').trim(),
    state: (r.querySelector('.log-row__due em')?.textContent || '').trim(),
    done: r.getAttribute('data-done'),
  }));
  out.push('② 任务日志 = ' + JSON.stringify(rows));
  out.push('   已提交条数 = ' + rows.filter((r) => r.state === '已提交').length);
  const lineThrough = rows.find((r) => r.done === 'true');
  if (lineThrough) {
    const el = [...document.querySelectorAll('.log-row')].find((r) => r.getAttribute('data-done') === 'true');
    const st = getComputedStyle(el.querySelector('.log-row__body strong'));
    out.push('   划掉样式 = ' + st.textDecorationLine + ' / ' + st.color);
  }

  // ③ 字体缩放：把滑块从 100% 拖到 125%
  tab(3);
  await sleep(700);
  const probe = () => {
    const el = document.querySelector('.conn__title strong') || document.querySelector('.log-row__body strong');
    return el === null ? null : getComputedStyle(el).fontSize;
  };
  const slider = document.querySelector('input[type="range"]');
  out.push('③ 滑块存在 = ' + (slider !== null) + ' 值 = ' + (slider?.value ?? '?'));
  const before = probe();
  if (slider) {
    slider.value = '1.25';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }
  await sleep(700);
  const after = probe();
  out.push('   字号 100% → ' + before + '   125% → ' + after);
  out.push('   --font-scale = ' + getComputedStyle(document.querySelector('.app')).getPropertyValue('--font-scale'));
  return out.join('\n');
})()