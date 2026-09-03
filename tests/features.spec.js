const { test, expect } = require('@playwright/test');
const { openApp, pasteBook, booksOnDisk } = require('./helpers');

const LONG = [...Array(10)].map((_, i) =>
  `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog. '.repeat(12)).join('\n\n');

test.describe('search inside a book', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
    await pasteBook(page, 'Libro', '## Chapter One\n\n' + LONG + '\n\n## Chapter Two\n\nA swirl of gritty dust came in with him.');
  });

  test('finds a word, says where it is, and jumps to it', async ({ page }) => {
    await page.locator('[data-action="openSearch"]').click();
    await expect(page.locator('#searchModal')).toBeVisible();
    await page.fill('#searchInput', 'gritty');
    await expect(page.locator('#searchCount')).toContainText('resultado');

    const hit = page.locator('.searchhit').first();
    await expect(hit.locator('mark')).toHaveText('gritty');
    await expect(hit.locator('.where')).toContainText('Chapter Two');

    await hit.click();
    await expect(page.locator('#searchModal')).toBeHidden();
    expect(await page.evaluate(() => current.titles[current.pos])).toContain('Chapter Two');
    await expect(page.locator('#readerText .w.hit')).toHaveText('gritty');
  });

  test('says so when there is nothing, and asks for two letters', async ({ page }) => {
    await page.locator('[data-action="openSearch"]').click();
    await page.fill('#searchInput', 'zzzzz');
    await expect(page.locator('#searchCount')).toContainText('Sin resultados');
    await page.fill('#searchInput', 'z');
    await expect(page.locator('#searchCount')).toContainText('dos letras');
  });

  test('a search term with markup cannot inject anything', async ({ page }) => {
    await page.evaluate(() => {
      current.chapters[0] = 'Here is <b>bold</b> and more text to find in the book.';
      renderChapter();
    });
    await page.locator('[data-action="openSearch"]').click();
    await page.fill('#searchInput', '<b>bold');
    await expect(page.locator('.searchhit')).toHaveCount(1);
    expect(await page.locator('.searchhit b').count()).toBe(0);
  });
});

test.describe('reading settings', () => {
  test('typography, line height and column width are applied and remembered', async ({ page }) => {
    await openApp(page);
    await pasteBook(page, 'Libro', LONG);
    await page.locator('[data-action="openReading"]').click();
    await expect(page.locator('#readingModal')).toBeVisible();

    await page.locator('[data-arg="font:legible"]').click();
    await page.locator('[data-arg="lh:2.1"]').click();
    await page.locator('[data-arg="width:620"]').click();

    const applied = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('readerText'));
      return { font: cs.fontFamily, lh: cs.lineHeight, fs: cs.fontSize,
               measure: getComputedStyle(document.querySelector('main')).maxWidth };
    });
    expect(applied.font).toMatch(/Verdana/);
    expect(parseFloat(applied.lh) / parseFloat(applied.fs)).toBeCloseTo(2.1, 1);
    expect(applied.measure).toBe('620px');

    // the chosen buttons are marked, for sighted and assistive users alike
    await expect(page.locator('[data-arg="font:legible"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-arg="font:serif"]')).toHaveAttribute('aria-pressed', 'false');

    await page.reload();
    await page.waitForFunction(() => typeof booksCache !== 'undefined');
    expect(await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--measure').trim())).toBe('620px');
  });
});

test.describe('reverse review', () => {
  test('the card can be turned round, and the sides are tagged by language', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      DB.vocab = [{ term: 'dawn', trans: 'amanecer', due: new Date().toISOString().slice(0, 10) }];
      updateDueBadge();
    });
    await page.locator('[data-action="openVocab"]').click();
    await page.locator('[data-action="openReview"]').click();

    await expect(page.locator('#revTerm')).toHaveText('dawn');
    await expect(page.locator('#revTerm')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#revDirBtn')).toHaveText('🇬🇧→🇪🇸');

    await page.locator('#revDirBtn').click();
    await expect(page.locator('#revTerm')).toHaveText('amanecer');
    await expect(page.locator('#revTerm')).toHaveAttribute('lang', 'es');
    await page.locator('#revShowRow button').click();
    await expect(page.locator('#revTrans')).toHaveText('dawn');
    await expect(page.locator('#revDirBtn')).toHaveText('🇪🇸→🇬🇧');

    // and the choice survives a reload
    await page.reload();
    await page.waitForFunction(() => typeof booksCache !== 'undefined');
    expect(await page.evaluate(() => DB.prefs.revReverse)).toBe(true);
  });
});

test.describe('accessibility', () => {
  test('a modal takes the focus, holds it, and gives it back', async ({ page }) => {
    await openApp(page);
    const opener = page.locator('[data-action="openVocab"]');
    await opener.click();
    await expect(page.locator('#vocabModal')).toBeVisible();

    // focus moved into the dialog
    expect(await page.evaluate(() =>
      document.getElementById('vocabModal').contains(document.activeElement))).toBe(true);

    // tabbing backwards from the first item stays inside
    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() =>
      document.getElementById('vocabModal').contains(document.activeElement))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('#vocabModal')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement.dataset.action)).toBe('openVocab');
  });

  test('a word can be looked up with the keyboard alone', async ({ page }) => {
    await openApp(page, { dict: () => '404', translate: () => 'polvo' });
    await pasteBook(page, 'Libro', 'A swirl of gritty dust came in with him.');

    await page.evaluate(() => {
      const word = [...document.querySelectorAll('#readerText .w')].find(w => w.textContent === 'dust');
      const range = document.createRange();
      range.selectNodeContents(word);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      document.getElementById('readerText').focus();
    });
    await page.keyboard.press('Enter');
    await expect(page.locator('#pop .term')).toHaveText('dust');
    await expect(page.locator('#pop .trans')).toContainText('polvo');
  });

  test('the popup and the toast announce themselves', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('#pop')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#pop')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#toast')).toHaveAttribute('role', 'status');
    await expect(page.locator('#readerText')).toHaveAttribute('tabindex', '0');
    for (const id of ['th-light', 'th-sepia', 'th-dark']) {
      await expect(page.locator('#' + id)).toHaveAttribute('aria-label', /Tema/);
    }
  });
});

test.describe('books stored before sections were capped', () => {
  test('are re-cut on load, keeping the reader roughly in place', async ({ page }) => {
    await openApp(page);
    // a book shaped like the old imports: one huge chapter, and the reader half way
    await page.evaluate(async () => {
      const huge = [...Array(40)].map((_, i) =>
        `Paragraph ${i}. ` + 'The quick brown fox jumps over the lazy dog. '.repeat(14)).join('\n\n');
      const book = { id: 'old1', title: 'Antiguo', chapters: [huge], titles: [''],
                     pos: 0, scroll: 0.5, words: 100, added: Date.now() };
      booksCache = [book];
      await persistBook(book);
    });
    const [before] = await booksOnDisk(page);
    expect(before.chapters).toHaveLength(1);
    expect(before.chapters[0].length).toBeGreaterThan(20000);

    await page.reload();
    await page.waitForFunction(() => typeof booksCache !== 'undefined' && booksCache.length === 1);
    await expect.poll(() => booksOnDisk(page).then(b => b[0].chapters.length)).toBeGreaterThan(5);

    const [after] = await booksOnDisk(page);
    expect(Math.max(...after.chapters.map(c => c.length))).toBeLessThan(4500);
    expect(after.resplit).toBe(1);
    // was half way through; should land near the middle of the new sections
    expect(after.pos).toBeGreaterThan(0);
    expect(after.pos).toBeLessThan(after.chapters.length - 1);
  });

  test('a book already the right shape is left alone', async ({ page }) => {
    await openApp(page);
    await pasteBook(page, 'Nuevo', LONG);
    const before = await booksOnDisk(page);
    await page.reload();
    await page.waitForFunction(() => typeof booksCache !== 'undefined' && booksCache.length === 1);
    const after = await booksOnDisk(page);
    expect(after[0].chapters).toEqual(before[0].chapters);
    expect(after[0].resplit).toBeUndefined();
  });
});
