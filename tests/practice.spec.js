const { test, expect } = require('@playwright/test');
const { openApp, pasteBook, TODAY, PLUS } = require('./helpers');

/** A Free Dictionary entry, in the shape the API really sends. */
const entry = (word, def) => ({
  word,
  phonetic: '/' + word + '/',
  phonetics: [{ text: '/' + word + '/', audio: 'https://api.dictionaryapi.dev/media/' + word + '.mp3' }],
  meanings: [{ partOfSpeech: 'verb', definitions: [{ definition: def || 'To do the thing.', example: word + ' now' }] }]
});

const seed = (page, items) => page.evaluate(v => { DB.vocab = v; updateDueBadge(); }, items);
const card = (page, i) => page.evaluate(n => DB.vocab[n], i || 0);
/** The word plus the review state a card needs to reach a given exercise. */
const at = (over) => Object.assign({
  term: 'dawn', trans: 'amanecer', kind: 'word', lemma: '', phon: '/dɔːn/', audio: '',
  def: 'The first light of day.', ctx: 'They walked at dawn along the road.',
  book: '', chapter: null, date: TODAY(), due: TODAY(), reviewed: '2026-01-01',
  interval: 6, ease: 2.5, reps: 3, step: 0, lapses: 0
}, over);

test.describe('what gets saved with a word', () => {
  test('a word is stored with the sentence it was met in, and with its book', async ({ page }) => {
    await openApp(page, { dict: w => entry(w, 'A wind that carries grit.'), translate: () => 'áspero' });
    await pasteBook(page, 'Mi libro',
      'The road was long.\n\nA gritty wind blew hard. Nobody spoke after that.');

    await page.locator('#readerText .w', { hasText: /^gritty$/ }).click();
    await expect(page.locator('#pop .trans')).toContainText('áspero');
    await page.locator('#pop [data-act="save"]').click();

    expect(await card(page)).toMatchObject({
      term: 'gritty',
      trans: 'áspero',
      kind: 'word',
      phon: '/gritty/',
      def: 'A wind that carries grit.',
      ctx: 'A gritty wind blew hard.',
      chapter: 0
    });
    expect(await page.evaluate(() => DB.vocab[0].book)).toBe(await page.evaluate(() => booksCache[0].id));
    expect(await page.evaluate(() => DB.vocab[0].audio)).toContain('gritty.mp3');
  });

  test('a phrase is saved as a phrase, without a sentence of its own', async ({ page }) => {
    await openApp(page, { translate: () => 'viento áspero' });
    await pasteBook(page, 'L', 'A gritty wind blew hard over the empty road.');
    await page.evaluate(() => {
      const words = [...document.querySelectorAll('#readerText .w')];
      const range = document.createRange();
      range.setStartBefore(words[1]); range.setEndAfter(words[2]);
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      showPopupAt(20, 20);
      lookupPhrase('gritty wind', sourceOfRange(range));
    });
    await expect(page.locator('#pop .trans')).toContainText('viento áspero');
    await page.locator('#pop [data-act="save"]').click();
    expect(await card(page)).toMatchObject({ term: 'gritty wind', kind: 'phrase', ctx: '' });
  });

  test('an inflected word is filed under its base form, and not saved twice', async ({ page }) => {
    await openApp(page, {
      dict: w => (w === 'go' ? entry('go', 'To move along.') : null),
      translate: () => 'ir'
    });
    await pasteBook(page, 'L', 'She went home. Later they had gone away for good.');

    await page.locator('#readerText .w', { hasText: /^went$/ }).click();
    await expect(page.locator('#pop .phon').nth(1)).toContainText('≈ go');
    await page.locator('#pop [data-act="save"]').click();
    expect(await card(page)).toMatchObject({ term: 'went', lemma: 'go' });

    // the same verb met again in another shape is the same word to learn
    await page.locator('#readerText .w', { hasText: /^gone$/ }).click();
    await page.locator('#pop [data-act="save"]').click();
    await expect(page.locator('#toast')).toContainText('Ya la tienes como «went»');
    expect(await page.evaluate(() => DB.vocab.length)).toBe(1);
  });
});

test.describe('the text remembers what you saved', () => {
  test('an inflected form of a saved word is underlined too', async ({ page }) => {
    await openApp(page);
    await seed(page, [at({ term: 'run', ctx: '', due: PLUS(9), interval: 9 })]);
    await pasteBook(page, 'L', 'He was running fast and the dogs ran behind him.');
    expect(await page.locator('#readerText .w.saved').allTextContents()).toEqual(['running', 'ran']);
    expect(await page.locator('#readerText .w.due').count()).toBe(0);
  });

  test('a word that is due today is marked out while reading', async ({ page }) => {
    await openApp(page);
    await seed(page, [
      at({ term: 'dawn', ctx: '', due: TODAY() }),
      at({ term: 'road', ctx: '', due: PLUS(4), interval: 4 })
    ]);
    await pasteBook(page, 'L', 'They walked at dawn along the road.');
    await expect(page.locator('#readerText .w.due')).toHaveText('dawn');
    expect(await page.locator('#readerText .w.saved').count()).toBe(2);
  });
});

test.describe('the exercises', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  test('a mature card asks you to complete the sentence from the book', async ({ page }) => {
    await seed(page, [at({ reps: 3 })]);
    await page.evaluate(() => openReview());
    await expect(page.locator('#revKind')).toHaveText('Completa la frase del libro');
    await expect(page.locator('#revCtx')).toContainText('They walked at');
    await expect(page.locator('#revCtx')).not.toContainText('dawn');
    await expect(page.locator('#revTerm')).toHaveText('amanecer');   // the meaning is the clue

    await page.locator('#revInput').fill('dawn');
    await page.locator('[data-action="checkTyped"]').click();
    await expect(page.locator('#revVerdict')).toHaveText('✅ Correcto');
    await expect(page.locator('#revCtx')).toContainText('They walked at dawn');
    // it graded itself, so it does not also ask whether you got it right
    await expect(page.locator('#revGradeRow button[data-arg="0"]')).toBeHidden();
    await expect(page.locator('#revGradeRow button[data-arg="1"]')).toBeVisible();
  });

  test('a young card asks you to produce the word, and a wrong answer only offers "otra vez"', async ({ page }) => {
    await seed(page, [at({ reps: 1, ctx: '' })]);
    await page.evaluate(() => openReview());
    await expect(page.locator('#revKind')).toHaveText('Escríbela en inglés');

    await page.locator('#revInput').fill('sunset');
    await page.keyboard.press('Enter');
    await expect(page.locator('#revVerdict')).toHaveText('❌ Era «dawn»');
    await expect(page.locator('#revGradeRow button[data-arg="0"]')).toBeVisible();
    await expect(page.locator('#revGradeRow button[data-arg="1"]')).toBeHidden();
    await expect(page.locator('#revGradeRow button[data-arg="2"]')).toBeHidden();

    await page.keyboard.press('Enter');                 // carry on with what it earned
    expect(await card(page)).toMatchObject({ reps: 0, lapses: 1, due: TODAY() });
  });

  test('one slipped key is a typo, not a word you did not know', async ({ page }) => {
    await seed(page, [at({ reps: 1, ctx: '' })]);
    await page.evaluate(() => openReview());
    await page.locator('#revInput').fill('dwan');
    await page.locator('[data-action="checkTyped"]').click();
    await expect(page.locator('#revVerdict')).toHaveText('✅ Casi: se escribe «dawn»');
    // near enough to pass, close enough that "otra vez" is still on offer
    await expect(page.locator('#revGradeRow button[data-arg="0"]')).toBeVisible();
    await expect(page.locator('#revGradeRow button[data-arg="1"]')).toBeVisible();
  });

  test('accents and case are not what is being tested', async ({ page }) => {
    await seed(page, [at({ term: 'café', trans: 'cafetería', reps: 1, ctx: '' })]);
    await page.evaluate(() => openReview());
    await page.locator('#revInput').fill('  CAFE ');
    await page.locator('[data-action="checkTyped"]').click();
    await expect(page.locator('#revVerdict')).toHaveText('✅ Correcto');
  });

  test('a brand new word is a multiple choice, drawn from your own vocabulary', async ({ page }) => {
    await seed(page, [
      at({ term: 'dawn', trans: 'amanecer', reps: 0, reviewed: undefined }),
      at({ term: 'road', trans: 'camino', due: PLUS(9), interval: 9 }),
      at({ term: 'wind', trans: 'viento', due: PLUS(9), interval: 9 }),
      at({ term: 'grit', trans: 'arena', due: PLUS(9), interval: 9 })
    ]);
    await page.evaluate(() => openReview());
    await expect(page.locator('#revKind')).toHaveText('Elige la respuesta');
    await expect(page.locator('#revTerm')).toHaveText('dawn');
    const options = await page.locator('#revChoiceRow button').allTextContents();
    expect(options).toHaveLength(4);
    expect(options).toContain('amanecer');
    expect(options.sort()).toEqual(['amanecer', 'arena', 'camino', 'viento']);

    await page.locator('#revChoiceRow button', { hasText: 'camino' }).click();
    await expect(page.locator('#revVerdict')).toHaveText('❌ Era «amanecer»');
    await expect(page.locator('#revChoiceRow button.ok')).toHaveText('amanecer');
    await expect(page.locator('#revChoiceRow button.no')).toHaveText('camino');
  });

  test('the options stay put when the same card comes round again', async ({ page }) => {
    await seed(page, [
      at({ term: 'dawn', trans: 'amanecer', reps: 0, reviewed: undefined }),
      at({ term: 'road', trans: 'camino', due: PLUS(9), interval: 9 }),
      at({ term: 'wind', trans: 'viento', due: PLUS(9), interval: 9 }),
      at({ term: 'grit', trans: 'arena', due: PLUS(9), interval: 9 })
    ]);
    await page.evaluate(() => openReview());
    const first = await page.locator('#revChoiceRow button').allTextContents();
    await page.locator('#revChoiceRow button', { hasText: 'camino' }).click();
    await page.locator('#revGradeRow button[data-arg="0"]').click();
    expect(await page.locator('#revChoiceRow button').allTextContents()).toEqual(first);
  });

  test('an older card is dictated, and the word is only shown afterwards', async ({ page }) => {
    await seed(page, [at({ reps: 4 })]);
    await page.evaluate(() => openReview());
    await expect(page.locator('#revKind')).toHaveText('Escucha y escríbela');
    await expect(page.locator('#revTerm')).toHaveText('🔊');
    await expect(page.locator('#revTrans')).toBeHidden();

    await page.locator('#revInput').fill('dawn');
    await page.locator('[data-action="checkTyped"]').click();
    await expect(page.locator('#revTrans')).toHaveText('dawn');
    await expect(page.locator('#revExtra')).toContainText('amanecer');
    await expect(page.locator('#revExtra')).toContainText('The first light of day.');
  });

  test('a phrase is only ever a flashcard', async ({ page }) => {
    await seed(page, [at({ term: 'at first light', trans: 'al amanecer', kind: 'phrase', reps: 6 })]);
    await page.evaluate(() => openReview());
    await expect(page.locator('#revKind')).toHaveText('¿Qué significa?');
    await expect(page.locator('#revShowRow')).toBeVisible();
    await expect(page.locator('#revTypeRow')).toBeHidden();
  });

  test('the reader can pin one kind of exercise, and it survives a reload', async ({ page }) => {
    await seed(page, [at({ reps: 3 })]);
    await page.evaluate(() => openReview());
    await expect(page.locator('#revKind')).toHaveText('Completa la frase del libro');
    await page.locator('#revModeSel').selectOption('flip');
    await expect(page.locator('#revKind')).toHaveText('¿Qué significa?');

    await page.reload();
    await page.waitForFunction(() => typeof booksCache !== 'undefined');
    expect(await page.evaluate(() => DB.prefs.revMode)).toBe('flip');
    // and the settings panel is showing the same choice
    await page.evaluate(() => openReading());
    await expect(page.locator('#prefExercise')).toHaveValue('flip');
  });

  test('a card that cannot support the pinned exercise falls back to a flashcard', async ({ page }) => {
    await page.evaluate(() => { const p = DB.prefs; p.revMode = 'cloze'; DB.prefs = p; });
    await seed(page, [at({ ctx: '' })]);              // nothing to make a gap in
    await page.evaluate(() => openReview());
    await expect(page.locator('#revKind')).toHaveText('¿Qué significa?');
    await expect(page.locator('#revShowRow')).toBeVisible();
  });
});

test.describe('how much work a day is', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  const many = n => Array.from({ length: n }, (_, i) => at({
    term: 'word' + i, trans: 'palabra' + i, ctx: '', reviewed: undefined, reps: 0
  }));

  test('only so many words you have never met are introduced in a day', async ({ page }) => {
    await seed(page, many(30));
    await expect(page.locator('#dueBadge')).toHaveText('10');       // the default allowance
    await page.evaluate(() => { const p = DB.prefs; p.newPerDay = 5; DB.prefs = p; updateDueBadge(); });
    await expect(page.locator('#dueBadge')).toHaveText('5');
    await page.evaluate(() => openReview());
    await expect(page.locator('#revProgress')).toHaveText('5 por repasar');
  });

  test('the allowance is spent for the day, not per session', async ({ page }) => {
    await page.evaluate(() => { const p = DB.prefs; p.newPerDay = 2; DB.prefs = p; });
    await seed(page, many(6));
    await page.evaluate(() => { openReview(); revealCard(); gradeCard(2); revealCard(); gradeCard(2); closeReview(); });
    expect(await page.evaluate(() => statFor(todayISO()).new)).toBe(2);
    await page.evaluate(() => openReview());
    await expect(page.locator('#reviewModal')).toBeHidden();
    await expect(page.locator('#toast')).toContainText('Ya has hecho lo de hoy');
  });

  test('a long backlog is cut down to one sitting', async ({ page }) => {
    await seed(page, Array.from({ length: 60 }, (_, i) => at({
      term: 'old' + i, trans: 'viejo' + i, ctx: '', reps: 4
    })));
    await expect(page.locator('#dueBadge')).toHaveText('40');       // the default session cap
    await page.evaluate(() => { const p = DB.prefs; p.sessionCap = 0; DB.prefs = p; updateDueBadge(); });
    await expect(page.locator('#dueBadge')).toHaveText('60');
  });

  test('the limits are set from the settings panel', async ({ page }) => {
    await page.evaluate(() => openReading());
    await page.locator('#prefNew button', { hasText: '20' }).click();
    await page.locator('#prefSession button', { hasText: 'Sin tope' }).click();
    expect(await page.evaluate(() => ({ n: DB.prefs.newPerDay, s: DB.prefs.sessionCap }))).toEqual({ n: 20, s: 0 });
    await expect(page.locator('#prefNew button', { hasText: '20' })).toHaveClass(/on/);
  });
});

test.describe('showing up', () => {
  test('the day is counted, and so is the streak', async ({ page }) => {
    await openApp(page);
    await seed(page, [at({ reps: 4, ctx: '' }), at({ term: 'road', trans: 'camino', ctx: '', reps: 4 })]);
    // two days already studied, ending yesterday
    await page.evaluate(([a, b]) => {
      DB.stats = { log: { [a]: { rev: 4, new: 1 }, [b]: { rev: 6, new: 2 } } };
    }, [await page.evaluate(() => addDays(-2)), await page.evaluate(() => addDays(-1))]);

    await page.evaluate(() => { openReview(); revealCard(); gradeCard(1); });
    expect(await page.evaluate(() => statFor(todayISO()))).toEqual({ rev: 1, new: 0 });
    expect(await page.evaluate(() => streakDays())).toBe(3);

    await page.evaluate(() => { revealCard(); gradeCard(1); closeReview(); });
    await page.evaluate(() => openVocab());
    await expect(page.locator('#vocabStats')).toContainText('3 días seguidos');
    await expect(page.locator('#vocabStats')).toContainText('2 repasadas hoy');
  });

  test('a day missed breaks the streak, and today alone does not', async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => streakDays())).toBe(0);
    await page.evaluate(d => { DB.stats = { log: { [d]: { rev: 3, new: 0 } } }; },
      await page.evaluate(() => addDays(-2)));
    expect(await page.evaluate(() => streakDays())).toBe(0);
    await page.evaluate(d => { DB.stats = { log: { [d]: { rev: 3, new: 0 } } }; },
      await page.evaluate(() => addDays(-1)));
    expect(await page.evaluate(() => streakDays())).toBe(1);       // still alive, today pending
  });

  test('a restored backup brings the review history back with it', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      DB.vocab = [{ term: 'dawn', trans: 'amanecer' }];
      DB.stats = { log: { '2026-01-01': { rev: 9, new: 3 } } };
    });
    const backup = await page.evaluate(() => {
      let out = null;
      const real = downloadBlob;
      window.downloadBlob = b => { out = b; };
      exportLibrary();
      window.downloadBlob = real;
      return out.text();
    });
    expect(JSON.parse(backup).stats.log['2026-01-01']).toEqual({ rev: 9, new: 3 });

    await page.evaluate(() => { DB.stats = {}; DB.vocab = []; });
    await page.evaluate(b => importLibrary(new File([b], 'b.json', { type: 'application/json' })), backup);
    await expect.poll(() => page.evaluate(() => (DB.stats.log || {})['2026-01-01']))
      .toEqual({ rev: 9, new: 3 });
  });
});

test.describe('finding a word again', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); });

  const mixed = () => [
    at({ term: 'dawn', trans: 'amanecer', reviewed: undefined, reps: 0, interval: 0 }),
    at({ term: 'road', trans: 'camino', reps: 2, interval: 6, due: PLUS(6) }),
    at({ term: 'wind', trans: 'viento', reps: 8, interval: 40, due: PLUS(40) }),
    at({ term: 'grit', trans: 'arena', reps: 1, interval: 1, lapses: 5, due: PLUS(1) }),
    at({ term: 'at first light', trans: 'al alba', kind: 'phrase', reps: 2, due: PLUS(6) })
  ];
  const shown = page => page.locator('.vocab-item .vt').allTextContents();

  test('the list can be filtered down to the words that matter', async ({ page }) => {
    await seed(page, mixed());
    await page.evaluate(() => openVocab());
    expect(await shown(page)).toHaveLength(5);

    await page.locator('#vocabFilter').selectOption('new');
    expect(await shown(page)).toEqual(['dawn']);
    await page.locator('#vocabFilter').selectOption('known');
    expect(await shown(page)).toEqual(['wind']);
    await page.locator('#vocabFilter').selectOption('hard');
    expect(await shown(page)).toEqual(['grit']);
    await page.locator('#vocabFilter').selectOption('phrase');
    expect(await shown(page)).toEqual(['at first light']);
    await page.locator('#vocabFilter').selectOption('due');
    expect(await shown(page)).toEqual(['dawn']);
  });

  test('the list can be searched in either language, and sorted', async ({ page }) => {
    await seed(page, mixed());
    await page.evaluate(() => openVocab());

    await page.locator('#vocabSearch').fill('camino');
    expect(await shown(page)).toEqual(['road']);
    await page.locator('#vocabSearch').fill('WIN');
    expect(await shown(page)).toEqual(['wind']);
    await page.locator('#vocabSearch').fill('');

    await page.locator('#vocabSort').selectOption('alpha');
    expect(await shown(page)).toEqual(['at first light', 'dawn', 'grit', 'road', 'wind']);
    await page.locator('#vocabSort').selectOption('hard');
    expect((await shown(page))[0]).toBe('grit');
  });

  test('nothing matching says so, rather than looking empty', async ({ page }) => {
    await seed(page, mixed());
    await page.evaluate(() => openVocab());
    await page.locator('#vocabSearch').fill('nada de nada');
    await expect(page.locator('#vocabNone')).toBeVisible();
    await expect(page.locator('#vocabEmpty')).toBeHidden();
  });

  test('a review can send you back to the page the word came from', async ({ page }) => {
    await pasteBook(page, 'Mi libro',
      'The first section is here.\n\nThey walked at dawn along the road and said nothing.');
    await page.evaluate(() => goToChapter(0));
    const book = await page.evaluate(() => booksCache[0].id);
    await seed(page, [at({ book, chapter: 0, reps: 3 })]);

    await page.evaluate(() => openReview());
    await page.locator('#revInput').fill('dawn');
    await page.locator('[data-action="checkTyped"]').click();
    await page.locator('#revSrc').click();

    await expect(page.locator('#reviewModal')).toBeHidden();
    await expect(page.locator('#reader')).toBeVisible();
    await expect(page.locator('#readerText .w.hit')).toHaveText('dawn');
  });
});
