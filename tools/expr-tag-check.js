(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tag = document.querySelector('.tag-self');
  if (tag === null) out.push('没有自建标记（当前页没有自建条目）');
  else {
    const r = tag.getBoundingClientRect();
    const cs = getComputedStyle(tag);
    out.push('标记 = ' + Math.round(r.width) + 'x' + Math.round(r.height)
      + ' 字号=' + cs.fontSize + ' 颜色=' + cs.color + ' 边框=' + cs.borderColor);
    const strong = tag.closest('strong');
    out.push('标题行高=' + (strong === null ? '-' : getComputedStyle(strong).lineHeight)
      + ' 标题行数=' + (strong === null ? '-' : Math.round(strong.getBoundingClientRect().height / parseFloat(getComputedStyle(strong).lineHeight))));
  }

  const body = document.querySelector('.app__body');
  out.push('首页 fits=' + (body.scrollHeight <= body.clientHeight + 1) + ' overflow=' + (body.scrollHeight - body.clientHeight));
  out.push('DDL 卡数=' + document.querySelectorAll('.ddl-card').length);

  // 标记是否挤出了卡片
  const overflow = [...document.querySelectorAll('.ddl-card')].some((c) => c.scrollWidth > c.clientWidth + 1);
  out.push('DDL 卡横向溢出 = ' + overflow);
  return out.join('\n');
})()