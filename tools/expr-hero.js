(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  const go = async (n) => { tabs().find((b) => b.textContent.includes(n))?.click(); await sleep(800); };
  await go('设置');
  for (let i = 0; i < 3; i += 1) { [...document.querySelectorAll('.conn')][i].querySelectorAll('button')[0]?.click(); await sleep(1500); }
  await go('首页');
  const read = (tag) => {
    const hero = document.querySelector('.quest-intro');
    const h1 = hero.querySelector('h1');
    const st = getComputedStyle(h1);
    const box = hero.getBoundingClientRect();
    return tag
      + ' h1=' + st.fontSize
      + ' 行数≈' + Math.round(h1.getBoundingClientRect().height / parseFloat(st.lineHeight))
      + ' b=' + getComputedStyle(hero.querySelector('.quest-intro__stats b')).fontSize
      + ' 卡高=' + Math.round(box.height)
      + ' 卡内溢出=' + (hero.scrollHeight > hero.clientHeight + 1)
      + ' 首页可滚动=' + document.querySelector('.home-grid').getAttribute('data-scroll');
  };
  out.push(read('默认'));
  const slider = (() => { tabs().find((b) => b.textContent.includes('设置')).click(); return document.querySelector('input[type="range"]'); })();
  await sleep(900);
  const s2 = document.querySelector('input[type="range"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s2, '1.25');
  s2.dispatchEvent(new Event('input', { bubbles: true })); s2.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(600);
  await go('首页');
  out.push(read('125%'));
  tabs().find((b) => b.textContent.includes('设置')).click(); await sleep(800);
  const s3 = document.querySelector('input[type="range"]');
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s3, '1');
  s3.dispatchEvent(new Event('input', { bubbles: true })); s3.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(500);
  return out.join('\n');
})()