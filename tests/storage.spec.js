const { test, expect } = require('@playwright/test');
const { openApp, pasteBook, booksOnDisk, exportedBackup, TODAY, PLUS } = require('./helpers');

test.beforeEach(async ({ page }) => { await openApp(page); });

test('a book far bigger than the localStorage quota is stored', async ({ page }) => {
  await page.evaluate(() => {
    const big = 'word '.repeat(400000);          // ~2 MB per chapter
    saveBook('Enorme', [big, big], ['Uno', 'Dos']);
  });
  await expect.poll(() => booksOnDisk(page).then(b => b.length)).toBe(1);
  const [stored] = await booksOnDisk(page);
  expect(stored.chapters.join('').length).toBeGreaterThan(3.9e6);
  expect(stored.titles).toEqual(['Uno', 'Dos']);
  // localStorage would have thrown well before this size
  expect(await page.evaluate(() => localStorage.getItem('ll_books'))).toBeNull();
});

test('a library written by the old localStorage version is migrated', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('ll_books', JSON.stringify([
      { id: 'oldB', title: 'Nuevo', chapters: ['Uno.', 'Dos.'], pos: 1, words: 2 },
      { id: 'oldA', title: 'Viejo', chapters: ['Solo.'], pos: 0, words: 1 }
    ]));
  });
  await page.reload();
  await page.waitForFunction(() => typeof booksCache !== 'undefined' && booksCache.length === 2);

  expect(await page.evaluate(() => booksCache.map(b => b.title))).toEqual(['Nuevo', 'Viejo']);
  expect(await page.evaluate(() => booksCache[0].pos)).toBe(1);
  expect(await page.evaluate(() => localStorage.getItem('ll_books'))).toBeNull();
  expect((await booksOnDisk(page)).length).toBe(2);
});

test('corrupt storage does not stop the app booting', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('ll_vocab', '{not json');
    localStorage.setItem('ll_prefs', '"a string where an object goes"');
  });
  await page.reload();
  await page.waitForFunction(() => typeof booksCache !== 'undefined');
  expect(await page.evaluate(() => Array.isArray(DB.vocab) && DB.vocab.length === 0)).toBe(true);
  await expect(page.locator('#library')).toBeVisible();
});

test('a backup round trip restores books, vocabulary and review schedule', async ({ page }) => {
  await pasteBook(page, 'Mi libro', '## Chapter One\n\nSome English text to read at leisure.');
  await page.evaluate(() => {
    DB.vocab = [{ term: 'dawn', trans: 'amanecer', date: '2026-01-01', due: '2026-12-24', interval: 9, ease: 2.7, reps: 4 }];
    setTheme('sepia');
  });
  const backup = JSON.parse(await exportedBackup(page));
  expect(backup.format).toBe('leerlibros-backup');
  expect(backup.books).toHaveLength(1);
  expect(backup.prefs.theme).toBe('sepia');

  // wipe the device, then restore
  await page.evaluate(async () => {
    for (const b of [...booksCache]) { booksCache = booksCache.filter(x => x.id !== b.id); await persistBook(null, b.id); }
    DB.vocab = []; setTheme('dark'); renderLibrary();
  });
  await page.evaluate(data => importLibrary(new File([JSON.stringify(data)], 'b.json', { type: 'application/json' })), backup);
  await expect.poll(() => page.evaluate(() => booksCache.length)).toBe(1);

  expect(await page.evaluate(() => booksCache[0].titles)).toEqual(['Chapter One']);
  expect(await page.evaluate(() => DB.vocab[0]))
    .toMatchObject({ term: 'dawn', due: '2026-12-24', interval: 9, ease: 2.7, reps: 4 });
  expect(await page.evaluate(() => document.body.dataset.theme)).toBe('sepia');
});

test('importing the same backup twice changes nothing', async ({ page }) => {
  await pasteBook(page, 'Libro', 'English text here for the test.');
  await page.evaluate(() => { DB.vocab = [{ term: 'dawn', trans: 'amanecer' }]; });
  const backup = await exportedBackup(page);
  await page.evaluate(b => importLibrary(new File([b], 'b.json', { type: 'application/json' })), backup);
  expect(await page.evaluate(() => ({ books: booksCache.length, vocab: DB.vocab.length }))).toEqual({ books: 1, vocab: 1 });
  await expect(page.locator('#toast')).toContainText('ya estaba');
});

test('a foreign or broken file cannot damage the library', async ({ page }) => {
  await pasteBook(page, 'Libro', 'English text here for the test.');
  await page.evaluate(() => goLibrary());

  await page.evaluate(() => importLibrary(new File(['not json'], 'x.json')));
  await expect(page.locator('#toast')).toContainText('No se pudo leer');

  await page.evaluate(() => importLibrary(new File([JSON.stringify({ hello: 'world' })], 'x.json')));
  await expect(page.locator('#toast')).toContainText('no es una copia');

  await page.evaluate(() => importLibrary(new File([JSON.stringify({
    books: [{ id: 1, title: 42, chapters: 'nope' }, null, { chapters: ['a valid chapter'] }], vocab: 'x'
  })], 'x.json')));
  await expect.poll(() => page.evaluate(() => booksCache.length)).toBe(2);   // only the valid one was added
  expect(await page.evaluate(() => booksCache.every(b => Array.isArray(b.chapters)))).toBe(true);
});

test('deleting a book removes it from disk too', async ({ page }) => {
  await pasteBook(page, 'Libro', 'English text here for the test.');
  await page.evaluate(() => goLibrary());
  page.on('dialog', d => d.accept());
  await page.locator('.bookcard .del').click();
  await expect.poll(() => booksOnDisk(page).then(b => b.length)).toBe(0);
  await expect(page.locator('#libEmpty')).toBeVisible();
});
