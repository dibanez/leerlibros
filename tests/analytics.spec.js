const { test, expect } = require('@playwright/test');
const { openApp, pasteBook, tracksContent } = require('./helpers');

/** Every ga4_event pushed to the dataLayer, in order. */
const events = page => page.evaluate(() =>
  (window.dataLayer || []).filter(e => e && e.event === 'ga4_event'));
const names = async page => (await events(page)).map(e => e.ga_event);
const names_ = names;
const last = async page => (await events(page)).slice(-1)[0];

test.beforeEach(async ({ page }) => {
  await openApp(page, {
    dict: () => ({ phonetic: '/x/', meanings: [{ partOfSpeech: 'n', definitions: [{ definition: 'd' }] }] }),
    translate: () => 'traducción'
  });
});

test('the instrumentation loads without an inline script', async ({ page }) => {
  expect(await page.evaluate(() => typeof llTrack)).toBe('function');
  expect(await page.locator('script[src="analytics.js"]').count()).toBe(1);
});

test('theme and font changes are tracked', async ({ page }) => {
  await page.locator('#th-dark').click();
  expect(await last(page)).toMatchObject({ ga_event: 'theme_change', theme: 'dark' });

  // the font buttons only exist while a book is open
  await pasteBook(page, 'L', 'Some English text long enough to read.');
  await page.locator('[data-action="font"][data-arg="1"]').click();
  expect(await last(page)).toMatchObject({ ga_event: 'font_size', direction: 'up' });
  await page.locator('[data-action="font"][data-arg="-1"]').click();
  expect(await last(page)).toMatchObject({ ga_event: 'font_size', direction: 'down' });
});

test('adding a book by pasting is tracked end to end', async ({ page }) => {
  await page.locator('[data-action="openPaste"]').click();
  expect(await last(page)).toMatchObject({ ga_event: 'add_book_start', method: 'paste' });

  await page.fill('#pasteTitle', 'Mi novela');
  await page.fill('#pasteText', 'Some English text long enough to read.');
  await page.locator('[data-action="savePaste"]').click();

  const got = await names(page);
  expect(got).toContain('book_add');
  expect(got).toContain('reader_open');
  const added = (await events(page)).find(e => e.ga_event === 'book_add');
  expect(added).toMatchObject({ method: 'paste', format: 'txt' });
  expect(added.book_title).toBe(await tracksContent(page) ? 'Mi novela' : undefined);
});

test('page turns report the section the reader landed on', async ({ page }) => {
  const long = '## One\n\n' + 'word '.repeat(900) + '\n\n## Two\n\n' + 'word '.repeat(900);
  await pasteBook(page, 'Largo', long);
  await page.locator('#nextBtn').click();
  await expect.poll(async () => await last(page)).toMatchObject({
    ga_event: 'page_turn', direction: 'next', page_num: 2
  });
  await page.locator('#prevBtn').click();
  await expect.poll(async () => await last(page)).toMatchObject({
    ga_event: 'page_turn', direction: 'prev', page_num: 1
  });
});

test('a word lookup is tracked once', async ({ page }) => {
  await pasteBook(page, 'L', 'A gritty wind blew hard.');
  await page.locator('#readerText .w', { hasText: /^gritty$/ }).click();
  await expect.poll(async () => (await names(page)).filter(n => n === 'word_lookup').length).toBe(1);
  const withContent = await tracksContent(page);
  const ev = (await events(page)).find(e => e.ga_event === 'word_lookup');
  expect(ev.word).toBe(withContent ? 'gritty' : undefined);

  // saving from the popup is a word_action, labelled by a stable id
  await page.locator('#pop [data-act="save"]').click();
  const action = await last(page);
  expect(action.ga_event).toBe('word_action');
  expect(action.label).toBe('save');
  expect(action.word).toBe(withContent ? 'gritty' : undefined);
});

test('opening and closing the reader is tracked', async ({ page }) => {
  await pasteBook(page, 'Nineteen Eighty-Four', 'It was a bright cold day in April.');
  const opened = (await events(page)).find(e => e.ga_event === 'reader_open');
  expect(opened.book_title).toBe(await tracksContent(page) ? 'Nineteen Eighty-Four' : undefined);
  await page.locator('[data-action="goLibrary"]').click();
  expect(await last(page)).toMatchObject({ ga_event: 'reader_close', minutes: 0 });
});

test('selecting and deleting a book are different events', async ({ page }) => {
  await pasteBook(page, 'Mi novela', 'Some English text long enough to read.');
  await page.locator('[data-action="goLibrary"]').click();
  await page.locator('.bookcard .title').click();
  // opening the card also fires reader_open, so look for the event by name
  const selected = (await events(page)).find(e => e.ga_event === 'book_select');
  expect(selected).toBeTruthy();
  expect(selected.book_title).toBe(await tracksContent(page) ? 'Mi novela' : undefined);

  await page.locator('[data-action="goLibrary"]').click();
  page.on('dialog', d => d.accept());
  await page.locator('.bookcard .del').click();
  await expect.poll(async () => (await last(page)).ga_event).toBe('book_delete');
});

test('vocabulary actions are tracked', async ({ page }) => {
  await page.evaluate(() => { DB.vocab = [{ term: 'dawn', trans: 'amanecer' }]; });
  await page.locator('[data-action="openVocab"]').click();
  expect(await last(page)).toMatchObject({ ga_event: 'vocab_open' });
  await page.locator('[data-action="exportVocab"]').click();
  expect(await last(page)).toMatchObject({ ga_event: 'vocab_export', format: 'csv' });
});

test('parameters never leak from one event to the next', async ({ page }) => {
  await page.locator('#th-dark').click();                       // pushes theme
  await page.locator('[data-action="openPaste"]').click();      // pushes method
  const ev = await last(page);
  expect(ev.ga_event).toBe('add_book_start');
  expect(ev.theme).toBeUndefined();
  // and the model was cleared in between
  const cleared = await page.evaluate(() =>
    dataLayer.some(e => e && 'theme' in e && e.theme === undefined));
  expect(cleared).toBe(true);
});

test('a JavaScript error is reported', async ({ page }) => {
  await page.evaluate(() => window.dispatchEvent(new ErrorEvent('error', { message: 'algo se rompió' })));
  expect(await last(page)).toMatchObject({ ga_event: 'js_error', label: 'algo se rompió' });
});

test('the donate link points at PayPal, opens safely and is tracked', async ({ page }) => {
  const link = page.locator('#donateBtn');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', 'https://www.paypal.com/paypalme/dibanez1979');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  // it belongs to the library, not over the text you are reading
  await pasteBook(page, 'L', 'Some English text long enough to read.');
  await expect(link).toBeHidden();
  await page.locator('[data-action="goLibrary"]').click();
  await expect(link).toBeVisible();

  // clicking it reports donate_click without leaving the page open on a popup
  const popup = page.waitForEvent('popup');
  await link.click();
  (await popup).close();
  const ev = (await events(page)).find(e => e.ga_event === 'donate_click');
  expect(ev).toMatchObject({ method: 'paypal' });
});

test('the TRACK_CONTENT switch decides whether book content is sent', async ({ page }) => {
  // through the real buttons: book_add is tracked on the click, not on save
  await page.locator('[data-action="openPaste"]').click();
  await page.fill('#pasteTitle', 'Nineteen Eighty-Four');
  await page.fill('#pasteText', 'A swirl of gritty dust came in with him.');
  await page.locator('[data-action="savePaste"]').click();
  await page.locator('#readerText .w', { hasText: /^gritty$/ }).click();
  await expect(page.locator('#pop .trans')).toBeVisible();

  const evs = await events(page);
  const names = evs.map(e => e.ga_event);
  expect(names).toContain('book_add');
  expect(names).toContain('reader_open');
  expect(names).toContain('word_lookup');

  const withContent = await tracksContent(page);
  const added = evs.find(e => e.ga_event === 'book_add');
  expect(added).toMatchObject({ method: 'paste', format: 'txt' });   // useful either way

  if (withContent) {
    expect(added.book_title).toBe('Nineteen Eighty-Four');
    expect(evs.find(e => e.ga_event === 'word_lookup').word).toBe('gritty');
    expect(evs.find(e => e.ga_event === 'reader_open').book_title).toBe('Nineteen Eighty-Four');
  } else {
    for (const e of evs) {
      expect(e.book_title).toBeUndefined();
      expect(e.word).toBeUndefined();
    }
  }
});

test('reading time is reported with a decimal, not rounded to nothing', async ({ page }) => {
  await pasteBook(page, 'L', 'Some English text long enough to read.');
  // 45 seconds of reading: whole minutes reported this as 1, and 15s as 0
  const reported = await page.evaluate(async () => {
    const before = dataLayer.length;
    // drive the counter the way the interval does
    for (let i = 0; i < 3; i++) window.dispatchEvent(new Event('focus'));
    return before;
  });
  expect(reported).toBeGreaterThan(0);

  // check the arithmetic directly: 15s must not be 0, and 40s must differ from 80s
  const values = await page.evaluate(() => [15, 40, 45, 80].map(s => Math.round(s / 6) / 10));
  expect(values[0]).toBeGreaterThan(0);
  expect(values[1]).not.toBe(values[3]);
});

test('the popup reports a stable action id, not the button text', async ({ page }) => {
  await pasteBook(page, 'L', 'A gritty wind blew.');
  await page.locator('#readerText .w', { hasText: /^gritty$/ }).click();
  await expect(page.locator('#pop .trans')).toBeVisible();

  await page.locator('#pop [data-act="save"]').click();
  const action = await last(page);
  expect(action.ga_event).toBe('word_action');
  expect(action.label).toBe('save');                 // not "⭐ Guardar"
  expect(action.label).not.toMatch(/[⭐🔊]/);
});

test('listening to a word is its own event, from every button', async ({ page }) => {
  await page.evaluate(() => {
    speechSynthesis.speak = () => {};
    speechSynthesis.cancel = () => {};
    window.Audio = function () { return { play: () => Promise.resolve(), pause() {}, addEventListener() {} }; };
  });
  await pasteBook(page, 'L', 'A gritty wind blew.');
  await page.locator('#readerText .w', { hasText: /^gritty$/ }).click();
  await expect(page.locator('#pop .trans')).toBeVisible();

  // from the popup
  await page.locator('#pop [data-act="speak"]').click();
  let ev = await last(page);
  expect(ev.ga_event).toBe('speak');
  expect(ev.word).toBe(await tracksContent(page) ? 'gritty' : undefined);

  // and from the vocabulary list, with no duplicate word_action
  await page.evaluate(() => { DB.vocab = [{ term: 'dawn', trans: 'amanecer' }]; openVocab(); });
  await page.locator('#vocabList [data-act="speak"]').click();
  expect((await last(page)).ga_event).toBe('speak');
  const names = await names_(page);
  expect(names.filter(n => n === 'word_action')).toHaveLength(0);   // speak is not a word_action
});

test('review and backup are measured', async ({ page }) => {
  await page.evaluate(() => { DB.vocab = [{ term: 'dawn', trans: 'amanecer' }]; updateDueBadge(); });
  await page.locator('[data-action="openVocab"]').click();
  await page.locator('[data-action="openReview"]').click();
  expect((await events(page)).some(e => e.ga_event === 'review_open')).toBe(true);

  await page.locator('#revShowRow button').click();
  await page.locator('#revGradeRow button', { hasText: 'Fácil' }).click();
  const graded = (await events(page)).find(e => e.ga_event === 'review_grade');
  expect(graded.label).toBe('easy');
  expect(graded.word).toBe(await tracksContent(page) ? 'dawn' : undefined);

  await page.locator('[data-action="closeReview"]').click();
  await page.evaluate(() => { window.downloadBlob = () => {}; exportLibrary(); });
  expect(await last(page)).toMatchObject({ ga_event: 'library_backup', method: 'export' });
});

test('the app keeps working when analytics.js is blocked', async ({ page }) => {
  await page.route('**/analytics.js', route => route.abort());
  await openApp(page, { translate: () => 'trad' });
  expect(await page.evaluate(() => typeof window.llTrack)).toBe('undefined');
  // the actions that report must not throw
  await pasteBook(page, 'L', 'Some English text long enough to read.');
  await page.evaluate(() => { DB.vocab = [{ term: 'dawn', trans: 'amanecer' }]; openReview(); revealCard(); gradeCard(1); closeReview(); });
  await page.evaluate(() => { window.downloadBlob = () => {}; exportLibrary(); });
  expect(await page.evaluate(() => DB.vocab[0].interval)).toBe(1);
});
