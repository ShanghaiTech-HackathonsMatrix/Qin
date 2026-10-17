(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 清掉之前几次实验留下的库（含被模拟数据污染的那一份）
  localStorage.clear();
  sessionStorage.clear();
  const dbs = (await indexedDB.databases?.()) ?? [];
  for (const db of dbs) {
    if (db.name) indexedDB.deleteDatabase(db.name);
  }
  await sleep(600);
  location.reload();
  return 'cleared: ' + JSON.stringify(dbs.map((d) => d.name));
})()