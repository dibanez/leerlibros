const { test, expect } = require('@playwright/test');
const { openApp, TODAY, PLUS } = require('./helpers');

/** Seeds the vocabulary in one write, the way the app itself does it. */
const seed = (page, items) => page.evaluate(v => { DB.vocab = v; updateDueBadge(); }, items);
const card = page => page.evaluate(() => DB.vocab[0]);
/** Opens a review, reveals the card and grades it. */
const gradeOnce = (page, grade) => page.evaluate(g => {
  openReview(); revealCard(); gradeCard(g); closeReview();
}, grade);

test.beforeEach(async ({ page }) => { await openApp(page, { translate: () => 'traducción' }); });

test('saving a word marks it due today and updates the badge', async ({ page }) => {
  await page.evaluate(() => saveVocab('dawn', 'amanecer'));
  expect(await card(page)).toMatchObject({ term: 'dawn', trans: 'amanecer', due: TODAY(), reps: 0 });
  await expect(page.locator('#dueBadge')).toHaveText('1');
  await expect(page.locator('#dueBadge')).toBeVisible();
});

test('saved words are underlined while reading', async ({ page }) => {
  await page.evaluate(() => {
    saveVocab('gritty', 'áspero');
    document.getElementById('pasteTitle').value = 'L';
    document.getElementById('pasteText').value = 'A gritty wind blew.';
    savePaste();
  });
  await expect(page.locator('#readerText .w.saved')).toHaveText('gritty');
});

test('the same word is not saved twice', async ({ page }) => {
  await page.evaluate(() => { saveVocab('dawn', 'a'); saveVocab('Dawn', 'b'); });
  expect(await page.evaluate(() => DB.vocab.length)).toBe(1);
});

test('a review session runs through every due card', async ({ page }) => {
  await seed(page, ['a', 'b', 'c'].map(t => ({ term: t, trans: 'tr-' + t, due: TODAY() })));
  await page.evaluate(() => openReview());
  await expect(page.locator('#reviewModal')).toBeVisible();
  await expect(page.locator('#vocabModal')).toBeHidden();
  await expect(page.locator('#revProgress')).toHaveText('3 por repasar');
  await expect(page.locator('#revTrans')).toBeHidden();

  await page.locator('#revShowRow button').click();
  await expect(page.locator('#revTrans')).toBeVisible();
  await expect(page.locator('#revGradeRow')).toBeVisible();

  for (let i = 0; i < 3; i++) {
    await page.locator('#revGradeRow button', { hasText: 'Bien' }).click();
    if (i < 2) await page.locator('#revShowRow button').click();
  }
  await expect(page.locator('#revDone')).toBeVisible();
  await expect(page.locator('#dueBadge')).toBeHidden();
});

test('SM-2 schedules a new card at 1 day for good and 3 for easy', async ({ page }) => {
  await seed(page, [{ term: 'w', trans: 't', due: TODAY() }]);
  await gradeOnce(page, 1);
  expect(await card(page)).toMatchObject({ interval: 1, reps: 1, due: PLUS(1) });

  await seed(page, [{ term: 'w', trans: 't', due: TODAY() }]);
  await gradeOnce(page, 2);
  expect(await card(page)).toMatchObject({ interval: 3, due: PLUS(3) });
});

test('SM-2 grows a mature card by its ease factor', async ({ page }) => {
  await seed(page, [{ term: 'w', trans: 't', due: TODAY(), reps: 2, interval: 6, ease: 2.5 }]);
  await gradeOnce(page, 1);
  expect((await card(page)).interval).toBe(15);          // 6 x 2.5
});

test('a failed card comes back today, with a lower ease', async ({ page }) => {
  await seed(page, [{ term: 'w', trans: 't', due: TODAY(), reps: 5, interval: 40, ease: 2.5 }]);
  await gradeOnce(page, 0);
  expect(await card(page)).toMatchObject({ interval: 0, reps: 0, due: TODAY(), ease: 2.3 });
});

test('the ease factor stays within its bounds', async ({ page }) => {
  await seed(page, [{ term: 'w', trans: 't', due: TODAY(), ease: 1.3, reps: 1, interval: 1 }]);
  await gradeOnce(page, 0);
  expect((await card(page)).ease).toBe(1.3);
  await seed(page, [{ term: 'w', trans: 't', due: TODAY(), ease: 2.95, reps: 3, interval: 20 }]);
  await gradeOnce(page, 2);
  expect((await card(page)).ease).toBe(3);
});

test('a failed card is shown again in the same session', async ({ page }) => {
  await seed(page, [{ term: 'a', trans: 'x', due: TODAY() }, { term: 'b', trans: 'y', due: TODAY() }]);
  await page.evaluate(() => { openReview(); revealCard(); gradeCard(0); });
  await expect(page.locator('#revProgress')).toHaveText('2 por repasar');
});

test('the keyboard drives a review', async ({ page }) => {
  await seed(page, [{ term: 'keyboard', trans: 'teclado', due: TODAY() }]);
  await page.evaluate(() => openReview());
  await page.keyboard.press('Space');
  await expect(page.locator('#revTrans')).toBeVisible();
  await page.keyboard.press('2');
  expect((await card(page)).interval).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#reviewModal')).toBeHidden();
});

test('with nothing due it says so instead of opening an empty session', async ({ page }) => {
  await seed(page, [{ term: 'w', trans: 't', due: PLUS(5) }]);
  await page.evaluate(() => openReview());
  await expect(page.locator('#reviewModal')).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Nada que repasar');
});

test('the vocabulary list shows when each word is next due', async ({ page }) => {
  await seed(page, [
    { term: 'hoy', trans: 'a', due: TODAY() },
    { term: 'manana', trans: 'b', due: PLUS(1) },
    { term: 'lejos', trans: 'c', due: PLUS(12) }
  ]);
  await page.evaluate(() => openVocab());
  expect(await page.locator('.vocab-item .vwhen').allTextContents()).toEqual(['hoy', 'mañana', 'en 12 d']);
  await expect(page.locator('#revCount')).toHaveText(' (1)');
});

test('escape closes any modal', async ({ page }) => {
  await page.evaluate(() => openVocab());
  await expect(page.locator('#vocabModal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#vocabModal')).toBeHidden();
});

test('the CSV export carries every saved word', async ({ page }) => {
  await seed(page, [{ term: 'dawn', trans: 'amanecer, alba', date: '2026-01-01' }]);
  const csv = await page.evaluate(() => {
    let out = null;
    const real = downloadBlob;
    window.downloadBlob = b => { out = b; };
    exportVocab();
    window.downloadBlob = real;
    return out.text();
  });
  expect(csv).toContain('term,translation,date');
  expect(csv).toContain('"dawn","amanecer, alba","2026-01-01"');
});
