JSON.stringify({
  topbarBtns: [...document.querySelectorAll('.topbar button')].map((b) => b.textContent.trim()),
  heroAdd: document.querySelector('.quest-intro__add') !== null,
  fab: document.querySelector('.fab') !== null,
  cards: [...document.querySelectorAll('.home-slot[data-card]')].map((el) => el.dataset.card),
  overdue: [...document.querySelectorAll('.ddl-card')].map((c) => ({
    t: (c.querySelector('.ddl-card__body strong')?.textContent || '').slice(0, 10),
    od: c.dataset.overdue,
    bg: getComputedStyle(c).backgroundColor,
  })),
})