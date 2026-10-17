(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = [...document.querySelectorAll('.tabbar button')];
  out.push('标签 = ' + JSON.stringify(tabs.map((b) => b.textContent.trim())));
  const academic = tabs.find((b) => b.textContent.includes('课业'));
  out.push('找到课业标签 = ' + (academic !== undefined));
  academic?.click();
  await sleep(1200);
  const body = document.querySelector('.app__body');
  out.push('页面标题 = ' + JSON.stringify([...document.querySelectorAll('summary, h3')].map((h) => h.textContent.trim()).slice(0, 6)));
  out.push('有「连接学习平台」= ' + (document.body.textContent.includes('连接学习平台')));
  out.push('Android 提示 = ' + JSON.stringify((document.body.textContent.match(/网页登录与同步[^。]*。/) || ['(无)'])[0]));
  const btns = [...document.querySelectorAll('.academic button')].map((b) => ({ t: b.textContent.trim(), disabled: b.disabled }));
  out.push('按钮（前 8）= ' + JSON.stringify(btns.slice(0, 8)));
  out.push('按钮总数 = ' + btns.length + ' 其中禁用 = ' + btns.filter((b) => b.disabled).length);
  out.push('横向溢出 = ' + (body.scrollWidth > body.clientWidth + 1));
  return out.join('\n');
})()