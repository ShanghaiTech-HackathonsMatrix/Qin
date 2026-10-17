(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.querySelectorAll('.tabbar button')[1].click();
  await sleep(700);
  const text = (document.querySelector('#root').textContent || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, 300);
})()
