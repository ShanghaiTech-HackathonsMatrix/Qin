(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tabs = () => document.querySelectorAll('.tabbar button');
  const probe = (label) => {
    const row = document.querySelector('.demo-list__row');
    if (row === null) return `${label}: (no .demo-list__row)`;
    const s = getComputedStyle(row);
    const r = row.getBoundingClientRect();
    return `${label}: layout=${document.documentElement.dataset.layout} h=${Math.round(r.height)} `
      + `border=${s.borderTopWidth}/${s.borderBottomWidth} radius=${s.borderTopLeftRadius} pad=${s.paddingLeft} bg=${s.backgroundColor}`;
  };
  const out = [];

  tabs()[1].click();          // 任务
  await sleep(500);
  out.push(probe('list 模式'));

  tabs()[3].click();          // 设置
  await sleep(400);
  const seg = [...document.querySelectorAll('.seg')].pop();   // 最后一个 seg = 列表样式
  const cardBtn = [...seg.querySelectorAll('button')].find((b) => b.textContent.trim() === '卡片');
  cardBtn.click();
  await sleep(400);

  tabs()[1].click();
  await sleep(500);
  out.push(probe('cards 模式'));

  tabs()[3].click();
  await sleep(300);
  const seg2 = [...document.querySelectorAll('.seg')].pop();
  [...seg2.querySelectorAll('button')].find((b) => b.textContent.trim() === '列表').click();
  await sleep(300);
  out.push('已复位为列表');
  return out.join('\n');
})()
