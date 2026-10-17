(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = [];
  const tabs = () => document.querySelectorAll('.tabbar button');
  const setValue = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // 任务页
  tabs()[1].click();
  await sleep(500);

  const create = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新建'));
  if (create === undefined) return 'FAIL: 找不到「＋ 新建」按钮';
  create.click();
  await sleep(500);

  const input = document.querySelector('.editor input, input[placeholder*="作业"]');
  if (input === null) return 'FAIL: 找不到标题输入框';
  setValue(input, '持久化自检 ' + Date.now());
  await sleep(200);

  const save = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '保存');
  if (save === undefined) return 'FAIL: 找不到保存按钮';
  log.push('save disabled = ' + save.disabled);
  save.click();
  await sleep(900);

  log.push('after save: ' + (document.querySelector('#root').textContent || '').replace(/\s+/g, ' ').trim().slice(0, 260));
  return log.join('\n');
})()
