(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(800);
  const slider = document.querySelector('input[type="range"]');
  const setRange = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const snap = (tag) => {
    const row = document.querySelector('.log-row__body strong');
    const lbl = document.querySelector('.lbl');
    const app = document.querySelector('.app');
    return tag + '  scale=' + getComputedStyle(app).getPropertyValue('--font-scale').trim()
      + '  .lbl=' + getComputedStyle(lbl).fontSize
      + '  横向溢出=' + (document.documentElement.scrollWidth > document.documentElement.clientWidth);
  };
  const out = [];
  for (const v of [1, 1.25, 0.9]) {
    setRange(slider, v); await sleep(500);
    out.push(snap(String(v)));
  }
  setRange(slider, 1); await sleep(400);
  out.push('还原后 ' + snap('1'));
  return out.join('\n');
})()