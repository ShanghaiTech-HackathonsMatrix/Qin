JSON.stringify((() => {
  const bar = document.querySelector('.tabbar');
  const body = document.querySelector('.app__body');
  const slots = [...document.querySelectorAll('.home-slot[data-card]')];
  const last = slots[slots.length - 1];
  const barTop = bar === null ? 0 : bar.getBoundingClientRect().top;
  const lastBottom = last === undefined ? 0 : last.getBoundingClientRect().bottom;
  return {
    vw: innerWidth,
    vh: innerHeight,
    tabbarH: bar === null ? null : Math.round(bar.getBoundingClientRect().height),
    tabbarTop: Math.round(barTop),
    lastCardBottom: Math.round(lastBottom),
    coveredByTabbar: lastBottom > barTop + 1,
    fits: body.scrollHeight <= body.clientHeight + 1,
    overflow: body.scrollHeight - body.clientHeight,
    padBottom: getComputedStyle(body).paddingBottom,
  };
})())