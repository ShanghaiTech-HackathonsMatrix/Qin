(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, value) => {
    const proto = HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const out = [];
  const measure = () => {
    const body = document.querySelector('.app__body');
    return {
      fits: body.scrollHeight <= body.clientHeight + 1,
      overflow: body.scrollHeight - body.clientHeight,
      fs: getComputedStyle(document.querySelector('.app')).getPropertyValue('--font-scale').trim(),
      ddlCardH: Math.round((document.querySelector('.ddl-card')?.getBoundingClientRect().height ?? 0)),
    };
  };

  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(500);
  setValue(document.querySelector('.slider input[type="range"]'), '1.25');
  await sleep(400);
  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(700);
  out.push('125% 首页 ' + JSON.stringify(measure()));

  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(400);
  setValue(document.querySelector('.slider input[type="range"]'), '0.9');
  await sleep(400);
  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(700);
  out.push(' 90% 首页 ' + JSON.stringify(measure()));

  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(400);
  setValue(document.querySelector('.slider input[type="range"]'), '1');
  await sleep(300);
  return out.join('\n');
})()