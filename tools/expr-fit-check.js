JSON.stringify((() => {
  const body = document.querySelector('.app__body');
  const stats = document.querySelector('.quest-intro__stats');
  const add = document.querySelector('.quest-intro__add');
  const b = (el) => (el === null ? null : { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) });
  const overflowX = [...document.querySelectorAll('.quest-intro__stats > *')].some((el) => {
    const r = el.getBoundingClientRect();
    const s = stats.getBoundingClientRect();
    return r.right > s.right + 1;
  });
  return {
    vw: innerWidth,
    vh: innerHeight,
    fits: body.scrollHeight <= body.clientHeight + 1,
    overflow: body.scrollHeight - body.clientHeight,
    stats: b(stats),
    add: b(add),
    statsOverflowX: overflowX,
    slots: [...document.querySelectorAll('.home-slot[data-card]')].map((el) => el.dataset.card + ':' + Math.round(el.getBoundingClientRect().height)),
  };
})())