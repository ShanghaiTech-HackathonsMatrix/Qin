(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const setValue = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const probe = (label) => {
    const slot = document.querySelector('.home-slot[data-card="ddl"]');
    const list = document.querySelector('.ddl-list');
    const cards = [...document.querySelectorAll('.ddl-card')];
    const clipped = cards.filter((c) => c.scrollHeight > c.clientHeight + 1).length;
    const bodyOverflow = [...document.querySelectorAll('.ddl-card__body strong')]
      .map((el) => el.scrollHeight > el.clientHeight + 1)
      .filter(Boolean).length;
    return label + ' ' + JSON.stringify({
      slotH: Math.round(slot?.getBoundingClientRect().height ?? 0),
      listScroll: list === null ? null : [list.scrollHeight, list.clientHeight],
      cards: cards.length,
      cardClipped: clipped,
      titleClipped: bodyOverflow,
      firstCardH: Math.round(cards[0]?.getBoundingClientRect().height ?? 0),
      titleFs: cards[0] === undefined ? null : getComputedStyle(cards[0].querySelector('.ddl-card__body strong')).fontSize,
    });
  };

  const out = [probe('100%')];

  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(500);
  setValue(document.querySelector('.slider input[type="range"]'), '1.25');
  await sleep(400);
  document.querySelectorAll('.tabbar button')[0].click();
  await sleep(700);
  out.push(probe('125%'));

  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(400);
  setValue(document.querySelector('.slider input[type="range"]'), '1');
  await sleep(300);
  return out.join('\n');
})()