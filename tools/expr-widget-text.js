JSON.stringify(
  [...document.querySelectorAll('.home-slot[data-card="widgets"] .ui-card, .home-slot[data-card="widgets"] .ui-list, .home-slot[data-card="widgets"] .ui-empty')]
    .map((el) => el.textContent.replace(/\s+/g, ' ').trim())
)