(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  const go = async (n) => { tabs().find((b) => b.textContent.includes(n))?.click(); await sleep(900); };
  await go('设置');
  for (let i = 0; i < 3; i += 1) { [...document.querySelectorAll('.conn')][i].querySelectorAll('button')[0]?.click(); await sleep(1600); }
  for (const t of ['首页', '任务', '课表', '日程', '设置']) {
    await go(t);
    const body = document.querySelector('.app__body');
    out.push(t.padEnd(3) + ' 副标题=' + (document.querySelector('.topbar__sub')?.textContent || '')
      + ' 横向溢出=' + (document.documentElement.scrollWidth > document.documentElement.clientWidth)
      + ' 首屏=' + (body?.innerText || '').replace(/\s+/g, ' ').slice(0, 70));
  }
  await go('课表');
  const day = document.querySelector('.timetable-day');
  out.push('课表卡片 = ' + (day?.className || '无') + ' 宽=' + Math.round(day?.getBoundingClientRect().width || 0) + 'px');
  const lesson = document.querySelector('.timetable-lesson');
  out.push('课时行宽=' + Math.round(lesson?.getBoundingClientRect().width || 0) + 'px 内层溢出=' + (lesson ? lesson.scrollWidth > lesson.clientWidth + 1 : '无'));
  return out.join('\n');
})()