(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(1600);
  const slider = document.querySelector('input[type="range"]');
  if (slider === null) return '找不到滑块；页面文本=' + document.body.innerText.replace(/\s+/g, ' ').slice(0, 200);
  const setRange = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const probe = () => {
    const sels = ['.lbl', '.conn__title strong', '.settings-row__label', '.quest-intro__eyebrow'];
    const found = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el !== null) found[s] = getComputedStyle(el).fontSize;
    }
    return 'scale=' + getComputedStyle(document.querySelector('.app')).getPropertyValue('--font-scale').trim()
      + ' ' + JSON.stringify(found)
      + ' 溢出=' + (document.documentElement.scrollWidth > document.documentElement.clientWidth);
  };
  for (const v of [1, 1.25, 0.9, 1]) { setRange(slider, v); await sleep(500); out.push(String(v).padEnd(5) + probe()); }
  return out.join('\n');
})()