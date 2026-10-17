(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const tabs = () => [...document.querySelectorAll('.tabbar button')];
  const go = async (n) => { tabs().find((b) => b.textContent.includes(n))?.click(); await sleep(900); };

  out.push('底栏 = ' + JSON.stringify(tabs().map((b) => b.textContent.trim())));

  // 先同步三个平台
  await go('设置');
  for (let i = 0; i < 3; i += 1) {
    [...document.querySelectorAll('.conn')][i].querySelectorAll('button')[0]?.click();
    await sleep(1800);
  }

  // 课表页
  await go('课表');
  out.push('副标题 = ' + document.querySelector('.topbar__sub')?.textContent);
  out.push('课表标题 = ' + document.querySelector('.quest-section__head h2')?.textContent
    + ' / ' + document.querySelector('.quest-section__ornament')?.textContent?.trim());
  out.push('周导航 = ' + document.querySelector('.timetable__week-label')?.textContent?.replace(/\s+/g, ' ').trim());
  const days = [...document.querySelectorAll('.timetable-day')].map((d) => ({
    d: d.querySelector('h3')?.textContent,
    date: d.querySelector('.timetable-day__date')?.textContent,
    today: d.getAttribute('data-today'),
    n: d.querySelectorAll('.timetable-lesson').length,
    first: d.querySelector('.timetable-lesson__body strong')?.textContent,
    time: d.querySelector('.timetable-lesson__time')?.textContent,
    where: d.querySelector('.timetable-lesson__body small')?.textContent,
  }));
  out.push('一周七天 = ' + JSON.stringify(days));

  // 翻到下一周
  document.querySelectorAll('.timetable__nav')[1]?.click();
  await sleep(700);
  out.push('下一周 = ' + document.querySelector('.timetable__week-label')?.textContent?.replace(/\s+/g, ' ').trim());

  // 首页：没有课程卡
  await go('首页');
  const homeText = document.querySelector('.app__body')?.innerText.replace(/\s+/g, ' ') || '';
  out.push('首页有「课程（」= ' + homeText.includes('课程（'));
  out.push('首页卡片 = ' + JSON.stringify([...document.querySelectorAll('.home-slot[data-card]')].map((s) => s.getAttribute('data-card'))));

  // hero 卡的描线与字号
  const hero = document.querySelector('.quest-intro');
  const hs = getComputedStyle(hero);
  out.push('hero 描线 = border ' + hs.borderTopWidth + ' + inset ' + hs.boxShadow);
  out.push('hero 字号 = h1 ' + getComputedStyle(hero.querySelector('h1')).fontSize
    + ' / p ' + getComputedStyle(hero.querySelector('p')).fontSize
    + ' / stats ' + getComputedStyle(hero.querySelector('.quest-intro__stats')).fontSize
    + ' / b ' + getComputedStyle(hero.querySelector('.quest-intro__stats b')).fontSize);
  const h1 = hero.querySelector('h1');
  out.push('h1 高度 = ' + Math.round(h1.getBoundingClientRect().height) + 'px（行高 ' + getComputedStyle(h1).lineHeight + '，换行会明显更高）');
  out.push('hero 卡高 = ' + Math.round(hero.getBoundingClientRect().height) + 'px');

  // 任务页：没有时间线
  await go('任务');
  const taskText = document.querySelector('.app__body')?.innerText || '';
  out.push('任务页含「插件视图」= ' + taskText.includes('插件视图') + '，含「时间线」= ' + taskText.includes('时间线'));

  return out.join('\n');
})()