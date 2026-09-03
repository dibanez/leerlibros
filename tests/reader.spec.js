const { test, expect } = require('@playwright/test');
const { openApp, pasteBook, importEpub, booksOnDisk } = require('./helpers');

const LONG = [...Array(8)].map((_, i) =>
  `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog. '.repeat(12)).join('\n\n');

test.beforeEach(async ({ page }) => { await openApp(page); });

test('a pasted book opens and every word is tappable', async ({ page }) => {
  await pasteBook(page, 'Mi libro', 'The quick brown fox jumps over the lazy dog.');
  await expect(page.locator('#readerTitle')).toHaveText('Mi libro');
  await expect(page.locator('#readerText .w')).toHaveCount(9);
  await expect(page.locator('#readerText')).toHaveAttribute('lang', 'en');
});

test('EPUB 3 chapter names come from the nav document', async ({ page }) => {
  await importEpub(page, 'epub3');
  await expect(page.locator('#readerTitle')).toHaveText('Novela EPUB3');
  const labels = await page.locator('#chapSel option').allTextContents();
  expect(labels).toEqual(['Sección 1 de 3', '2. El Comienzo', '3. El Desenlace']);
});

test('EPUB 2 chapter names come from the NCX', async ({ page }) => {
  await importEpub(page, 'epub2');
  const labels = await page.locator('#chapSel option').allTextContents();
  expect(labels).toEqual(['Sección 1 de 3', '2. El Comienzo', '3. El Desenlace']);
});

test('a wrapper <div> does not make the EPUB text appear twice', async ({ page }) => {
  await importEpub(page, 'epub3');
  const chapters = await page.evaluate(() => current.chapters);
  for (const c of chapters) expect(c.match(/Body of section/g)).toHaveLength(1);
});

test('the chapter picker jumps, and both pickers stay in sync', async ({ page }) => {
  await importEpub(page, 'epub3');
  await page.selectOption('#chapSel', '2');
  expect(await page.evaluate(() => current.pos)).toBe(2);
  await expect(page.locator('#chapSel2')).toHaveValue('2');
  await expect(page.locator('#nextBtn')).toBeDisabled();
});

test('pasted text takes its titles from ## headings', async ({ page }) => {
  await pasteBook(page, 'Con títulos', '## Chapter One\n\n' + LONG + '\n\n## Chapter Two\n\n' + LONG);
  const labels = await page.locator('#chapSel option').allTextContents();
  expect(labels[0]).toBe('1. Chapter One');
});

test('the place inside a section is remembered, but a new section starts at the top', async ({ page }) => {
  await pasteBook(page, 'Largo', LONG);
  const id = await page.evaluate(() => current.id);

  await page.evaluate(() => {
    window.scrollTo(0, Math.round((document.documentElement.scrollHeight - window.innerHeight) * 0.6));
    window.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.evaluate(() => current.scroll)).toBeGreaterThan(0.5);

  // leaving and coming back lands in the same place
  await page.evaluate(id => { goLibrary(); openBook(id); }, id);
  await expect.poll(() => page.evaluate(() =>
    Math.abs(window.scrollY - (document.documentElement.scrollHeight - window.innerHeight) * current.scroll)
  )).toBeLessThan(30);

  // and it is on disk, not only in memory
  const [stored] = await booksOnDisk(page);
  expect(stored.scroll).toBeGreaterThan(0.5);
});

test('changing section resets the reading place', async ({ page }) => {
  await pasteBook(page, 'Largo', LONG + '\n\n' + LONG);
  await page.evaluate(() => {
    window.scrollTo(0, 400);
    window.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.evaluate(() => current.scroll)).toBeGreaterThan(0);
  await page.evaluate(() => nextChapter());
  expect(await page.evaluate(() => ({ scroll: current.scroll, y: window.scrollY }))).toEqual({ scroll: 0, y: 0 });
});

test('arrow keys turn sections, but never while a field has focus', async ({ page }) => {
  await pasteBook(page, 'Largo', LONG + '\n\n' + LONG);
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => current.pos)).toBe(1);

  // typing in a modal must not turn pages behind it
  await page.evaluate(() => openPaste());
  await page.locator('#pasteText').focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => current.pos)).toBe(1);
  await page.keyboard.press('Escape');

  // and the picker moves exactly one section, not two
  await page.locator('#chapSel').focus();
  await page.keyboard.press('ArrowLeft');
  expect(await page.evaluate(() => current.pos)).toBe(0);
});

test('× and ÷ are separators, not letters', async ({ page }) => {
  const words = await page.evaluate(() =>
    [...wrapWords('a×b done ÷ naïve', new Set()).matchAll(/<span class="w">([^<]+)<\/span>/g)].map(m => m[1]));
  expect(words).toEqual(['a', 'b', 'done', 'naïve']);
});
