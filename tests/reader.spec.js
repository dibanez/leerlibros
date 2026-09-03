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

test('pasted text is cut at its ## headings, just like an EPUB', async ({ page }) => {
  await pasteBook(page, 'Con títulos', '## Chapter One\n\n' + LONG + '\n\n## Chapter Two\n\n' + LONG);
  const titles = await page.evaluate(() => current.titles);
  expect(titles[0]).toMatch(/^Chapter One/);
  expect(titles.some(t => /^Chapter Two/.test(t))).toBe(true);
  // each heading owns its sections in the picker
  const groups = await page.locator('#chapSel optgroup').evaluateAll(gs => gs.map(g => g.label));
  expect(groups).toContain('Chapter One');
  expect(groups).toContain('Chapter Two');
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

/** An EPUB shaped like a real one: several chapters per file, one huge paragraph. */
async function importFatEpub(page) {
  await page.evaluate(async () => {
    const JSZipLib = await loadJSZip();
    const z = new JSZipLib();
    z.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const prose = 'It was a bright cold day in April and the clocks were striking thirteen. '.repeat(60);
    const letter = 'Two offences of a very different nature and by no means of equal magnitude you last night laid to my charge. '.repeat(130);
    // one file, three chapters, and a single paragraph of ~14 KB
    z.file('c1.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml"><body>' +
      '<h2 style="text-align:center">CHAPTER I.</h2><p style="margin:0">' + prose + '</p>' +
      '<h2 style="text-align:center">CHAPTER II.</h2><p>' + prose + '</p>' +
      '<h2 style="text-align:center">CHAPTER III.</h2><p>' + letter + '</p>' +
      '</body></html>');
    z.file('c.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Libro Gordo</dc:title></metadata>' +
      '<manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>');
    await loadEpub(new File([await z.generateAsync({ type: 'blob' })], 'gordo.epub'), 'x');
  });
  await expect(page.locator('#reader')).toBeVisible();
}

test('a fat EPUB file is cut into readable sections, not one endless scroll', async ({ page }) => {
  await importFatEpub(page);
  const lens = await page.evaluate(() => current.chapters.map(c => c.length));
  expect(lens.length).toBeGreaterThan(5);
  // no section may exceed the limit by more than one indivisible piece
  expect(Math.max(...lens)).toBeLessThan(4500);
});

test('several chapters in one EPUB file each get their own name', async ({ page }) => {
  await importFatEpub(page);
  const titles = await page.evaluate(() => current.titles);
  expect(titles.some(t => /^CHAPTER I\./.test(t))).toBe(true);
  expect(titles.some(t => /^CHAPTER II\./.test(t))).toBe(true);
  expect(titles.some(t => /^CHAPTER III\./.test(t))).toBe(true);
  // a chapter that needed splitting says which part you are on
  expect(titles.some(t => /· \d+\/\d+$/.test(t))).toBe(true);
});

test('a paragraph longer than a whole section is broken at sentence ends', async ({ page }) => {
  await importFatEpub(page);
  const parts = await page.evaluate(() =>
    current.chapters.filter(c => c.includes('Two offences')).map(c => c.length));
  expect(parts.length).toBeGreaterThan(3);              // the 14 KB paragraph was split
  expect(Math.max(...parts)).toBeLessThan(4500);
  // and it was cut at sentences, not mid-word
  const cuts = await page.evaluate(() =>
    current.chapters.filter(c => c.includes('Two offences')).map(c => c.trim().slice(-1)));
  expect(cuts.every(c => /[.!?"”']/.test(c))).toBe(true);
});

test('importing an EPUB raises no Content-Security-Policy violation', async ({ page }) => {
  const violations = [];
  page.on('console', m => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await importFatEpub(page);                            // its markup is full of style=""
  expect(violations).toEqual([]);
});

test('a section stays a few screens tall on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importFatEpub(page);
  const screens = await page.evaluate(() => {
    const worst = current.chapters.map(c => c.length);
    goToChapter(worst.indexOf(Math.max(...worst)));
    return document.documentElement.scrollHeight / window.innerHeight;
  });
  expect(screens).toBeLessThan(12);                     // it used to be over 40
});

test('the chapter picker groups the parts of each chapter', async ({ page }) => {
  await importFatEpub(page);
  const groups = await page.locator('#chapSel optgroup').allTextContents();
  expect(groups.length).toBeGreaterThan(0);
  const labels = await page.locator('#chapSel optgroup').evaluateAll(gs => gs.map(g => g.label));
  expect(labels.some(l => /^CHAPTER /.test(l))).toBe(true);
  // inside a group the options are just the part numbers, not the title again
  const inside = await page.locator('#chapSel optgroup option').first().textContent();
  expect(inside).toMatch(/^\d+\.\s*\d+\/\d+$/);
  // and picking one still jumps
  const value = await page.locator('#chapSel optgroup option').nth(1).getAttribute('value');
  await page.selectOption('#chapSel', value);
  expect(String(await page.evaluate(() => current.pos))).toBe(value);
});
