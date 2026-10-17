(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  const px = (sel, prop) => {
    const el = document.querySelector(sel);
    return el === null ? '(无)' : getComputedStyle(el)[prop];
  };

  // 设置页
  document.querySelectorAll('.tabbar button')[3].click();
  await sleep(600);
  const row = document.querySelector('.slider');
  const range = document.querySelector('.slider input[type="range"]');
  out.push('滑轨行高=' + (row === null ? '-' : Math.round(row.getBoundingClientRect().height))
    + ' 滑轨宽=' + (range === null ? '-' : Math.round(range.getBoundingClientRect().width))
    + ' 当前值=' + (range === null ? '-' : range.value)
    + ' 标签=' + (document.querySelector('.slider__value')?.textContent ?? '-'));
  out.push('设置页正文基准 = ' + px('.faint', 'fontSize'));

  // 日程页
  document.querySelectorAll('.tabbar button')[2].click();
  await sleep(600);
  out.push('日程 标题字号=' + px('.schedule-entry__body strong', 'fontSize')
    + ' 时间字号=' + px('.schedule-entry__time', 'fontSize')
    + ' 条目数=' + document.querySelectorAll('.schedule-entry').length);

  // 任务页
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(600);
  out.push('任务页 标题字号=' + px('.log-row__body strong', 'fontSize')
    + ' 截止字号=' + px('.log-row__due b', 'fontSize')
    + ' 逾期行数=' + document.querySelectorAll('.log-row[data-overdue="true"]').length);
  const od = document.querySelector('.log-row[data-overdue="true"]');
  out.push('逾期行配色 = ' + (od === null ? '(今天没有逾期)' : getComputedStyle(od).backgroundColor + ' / ' + getComputedStyle(od).color));

  return out.join('\n');
})()