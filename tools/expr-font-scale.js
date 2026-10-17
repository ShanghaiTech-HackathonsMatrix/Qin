(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(800);
  const setRange = (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const probe = () => {
    const pick = ['.conn__title strong', '.lbl', '.log-row__body strong'];
    const res = {};
    for (const sel of pick) {
      const el = document.querySelector(sel);
      res[sel] = el === null ? null : getComputedStyle(el).fontSize;
    }
    res['--font-scale'] = getComputedStyle(document.querySelector('.app')).getPropertyValue('--font-scale').trim();
    res['tabbar-h'] = Math.round(document.querySelector('.tabbar').getBoundingClientRect().height);
    res['tabbar 字号'] = getComputedStyle(document.querySelector('.tabbar button')).fontSize;
    return res;
  };
  const slider = document.querySelector('input[type="range"]');
  out.push('滑块 min/max/step = ' + slider.min + '/' + slider.max + '/' + slider.step);
  out.push('100% → ' + JSON.stringify(probe()));
  setRange(slider, 1.25); await sleep(600);
  out.push('125% → ' + JSON.stringify(probe()));
  setRange(slider, 0.9); await sleep(600);
  out.push(' 90% → ' + JSON.stringify(probe()));
  // 还原
  setRange(slider, 1); await sleep(400);
  return out.join('\n');
})()