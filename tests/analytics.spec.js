const { test, expect } = require('@playwright/test');
const { openApp, pasteBook } = require('./helpers');

/** Every ga4_event pushed to the dataLayer, in order. */
const events = page => page.evaluate(() =>
  (window.dataLayer || []).filter(e => e && e.event === 'ga4_event'));
const names = async page => (await events(page)).map(e => e.ga_event);
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
  expect(added.book_title).toBeUndefined();          // titles stay on the device
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

test('a word lookup is tracked once, without the word itself', async ({ page }) => {
  await pasteBook(page, 'L', 'A gritty wind blew hard.');
  await page.locator('#readerText .w', { hasText: /^gritty$/ }).click();
  await expect.poll(async () => (await names(page)).filter(n => n === 'word_lookup').length).toBe(1);
  const ev = (await events(page)).find(e => e.ga_event === 'word_lookup');
  expect(ev.word).toBeUndefined();

  // saving from the popup is a word_action, labelled by the button, not the word
  await page.locator('#pop [data-act="save"]').click();
  const action = await last(page);
  expect(action.ga_event).toBe('word_action');
  expect(action.label).toContain('Guardar');
  expect(action.word).toBeUndefined();
});

test('opening and closing the reader is tracked', async ({ page }) => {
  await pasteBook(page, 'Nineteen Eighty-Four', 'It was a bright cold day in April.');
  const opened = (await events(page)).find(e => e.ga_event === 'reader_open');
  expect(opened.book_title).toBeUndefined();
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
  expect(selected.book_title).toBeUndefined();

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

test('book content is counted but not sent to analytics', async ({ page }) => {
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

  // the events are there; the reader's words and titles are not
  for (const e of evs) {
    expect(e.book_title).toBeUndefined();
    expect(e.word).toBeUndefined();
  }
  const added = evs.find(e => e.ga_event === 'book_add');
  expect(added).toMatchObject({ method: 'paste', format: 'txt' });   // still useful
});
