const { test, expect } = require('@playwright/test');
const { openApp, TODAY } = require('./helpers');

// The vocabulary and the review are what a reader opens on a phone, standing
// up, one-handed. These check the things that only go wrong at that size.
test.use({ viewport: { width: 393, height: 727 }, isMobile: true, hasTouch: true });

const seed = (page, items) => page.evaluate(v => { DB.vocab = v; updateDueBadge(); }, items);
/** Pins one exercise, so a test is not at the mercy of what "mixto" picks. */
const pin = (page, mode) => page.evaluate(m => { const p = DB.prefs; p.revMode = m; DB.prefs = p; }, mode);
const word = (over) => Object.assign({
  term: 'dawn', trans: 'amanecer', kind: 'word', phon: '/dɔːn/', audio: '', lemma: '',
  def: 'The first light of day.', ctx: 'They walked at dawn along the road.',
  book: '', chapter: null, date: TODAY(), due: TODAY(), reviewed: '2026-01-01',
  interval: 6, ease: 2.5, reps: 3, step: 0, lapses: 0
}, over);

/** Drags the review card sideways with a real sequence of touch events. */
async function swipeCard(page, dx) {
  await page.evaluate(d => {
    const el = document.getElementById('revCard');
    const box = el.getBoundingClientRect();
    const y = box.top + box.height / 2, x0 = box.left + box.width / 2;
    const at = x => [new Touch({ identifier: 1, target: el, clientX: x, clientY: y })];
    const fire = (type, x) => el.dispatchEvent(new TouchEvent(type, {
      bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : at(x),
      changedTouches: at(x)
    }));
    fire('touchstart', x0);
    fire('touchmove', x0 + d / 2);
    fire('touchmove', x0 + d);
    fire('touchend', x0 + d);
  }, dx);
}

test.describe('the sheets take the whole screen', () => {
  const sheetFills = page => page.evaluate(() => {
    const open = [...document.querySelectorAll('.modal-bg')].find(m => m.style.display === 'flex');
    const sheet = open.querySelector('.sheet');
    const box = sheet.getBoundingClientRect();
    const foot = sheet.querySelector('.sheet-foot').getBoundingClientRect();
    return {
      full: Math.round(box.height) === window.innerHeight && Math.round(box.width) === window.innerWidth,
      // the buttons you press are on screen, not below the fold
      footVisible: foot.bottom <= Math.round(box.bottom) + 1 && foot.height > 0,
      pageLocked: getComputedStyle(document.body).overflow === 'hidden'
    };
  });

  test('the vocabulary is a screen, not a card floating over the book', async ({ page }) => {
    await openApp(page);
    await seed(page, [word({})]);
    await page.evaluate(() => openVocab());
    expect(await sheetFills(page)).toEqual({ full: true, footVisible: true, pageLocked: true });

    await page.locator('#vocabModal .sheet-x').click();
    expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  });

  test('the review is too, and the answer buttons stay put between cards', async ({ page }) => {
    await openApp(page);
    await seed(page, [
      word({ term: 'dawn', ctx: 'They walked at dawn.' }),
      word({ term: 'road', trans: 'camino', ctx: 'A very long sentence indeed, met along the road '
        + 'and running well past a single line so the card grows taller than the one before it.' })
    ]);
    await pin(page, 'flip');
    await page.evaluate(() => openReview());
    expect(await sheetFills(page)).toEqual({ full: true, footVisible: true, pageLocked: true });

    const rowTop = () => page.evaluate(() =>
      Math.round(document.getElementById('revShowRow').getBoundingClientRect().top));
    const first = await rowTop();
    await page.locator('#revShowRow button').click();
    await page.locator('#revGradeRow button[data-arg="1"]').click();
    expect(await rowTop()).toBe(first);
  });

  test('nothing in a pinned bar is smaller than a fingertip', async ({ page }) => {
    await openApp(page);
    await seed(page, [word({}), word({ term: 'road', trans: 'camino' })]);
    await pin(page, 'choice');
    await page.evaluate(() => { openVocab(); openReview(); });
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('#reviewModal button, #reviewModal select')]
        .map(el => [el.textContent.trim().slice(0, 12), el.getBoundingClientRect()])
        .filter(([, b]) => b.width > 0 && (b.width < 40 || b.height < 40))
        .map(([t]) => t));
    expect(small).toEqual([]);
  });
});

test.describe('swiping the card', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  test('left is "otra vez" and right is "bien"', async ({ page }) => {
    await seed(page, [word({ term: 'dawn' }), word({ term: 'road', trans: 'camino' })]);
    await pin(page, 'flip');
    await page.evaluate(() => { openReview(); revealCard(); });
    const shown = await page.locator('#revTerm').textContent();

    await swipeCard(page, 160);
    await expect(page.locator('#revTerm')).not.toHaveText(shown);
    expect(await page.evaluate(t => DB.vocab.find(v => v.term === t).reps, shown)).toBe(4);

    const second = await page.locator('#revTerm').textContent();
    await page.locator('#revShowRow button').click();
    await swipeCard(page, -160);
    expect(await page.evaluate(t => DB.vocab.find(v => v.term === t), second))
      .toMatchObject({ reps: 0, lapses: 1, due: TODAY() });
  });

  test('a nudge is not an answer, and neither is a swipe the card is not offering',
    async ({ page }) => {
      await seed(page, [word({ reps: 1, ctx: '' })]);
      await page.evaluate(() => openReview());
      await page.locator('#revInput').fill('dawn');
      await page.locator('[data-action="checkTyped"]').click();
      // the app graded it right, so "otra vez" is not on offer and cannot be swiped to
      await expect(page.locator('#revGradeRow button[data-arg="0"]')).toBeHidden();
      await swipeCard(page, -160);
      expect(await page.evaluate(() => DB.vocab[0].lapses)).toBe(0);

      await swipeCard(page, -20);            // too short to mean anything
      expect(await page.evaluate(() => DB.vocab[0].reviewed)).toBe('2026-01-01');
      await swipeCard(page, 160);
      expect(await page.evaluate(() => DB.vocab[0].reviewed)).toBe(TODAY());
    });

  test('a card being asked cannot be swiped away by accident', async ({ page }) => {
    await seed(page, [word({})]);
    await pin(page, 'flip');
    await page.evaluate(() => openReview());
    await swipeCard(page, 200);
    await expect(page.locator('#revShowRow')).toBeVisible();
    expect(await page.evaluate(() => DB.vocab[0].reviewed)).toBe('2026-01-01');
  });
});

test('a word deleted by a stray thumb can be put back', async ({ page }) => {
  await openApp(page);
  await seed(page, [word({ term: 'dawn' }), word({ term: 'road', trans: 'camino' })]);
  await page.evaluate(() => openVocab());

  await page.locator('.vocab-item [data-act="del"]').first().click();
  expect(await page.evaluate(() => DB.vocab.map(v => v.term))).toEqual(['road']);

  await page.locator('#toast .toast-do').click();
  expect(await page.evaluate(() => DB.vocab.map(v => v.term))).toEqual(['dawn', 'road']);
  await expect(page.locator('.vocab-item')).toHaveCount(2);
});

test('the session shows how much of it is left', async ({ page }) => {
  await openApp(page);
  await seed(page, Array.from({ length: 4 }, (_, i) =>
    word({ term: 'w' + i, trans: 't' + i, ctx: '' })));
  const bar = () => page.evaluate(() => document.querySelector('#revBar i').style.width);

  await pin(page, 'flip');
  await page.evaluate(() => openReview());
  expect(await bar()).toBe('0%');
  for (const expected of ['25%', '50%', '75%', '100%']) {
    await page.evaluate(() => { revealCard(); gradeCard(1); });
    expect(await bar()).toBe(expected);
  }
  await expect(page.locator('#revDone')).toBeVisible();
  await page.locator('#revDoneRow button').click();
  await expect(page.locator('#reviewModal')).toBeHidden();
});
