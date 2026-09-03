const { test, expect } = require('@playwright/test');
const { openApp, pasteBook } = require('./helpers');

const ENTRY = (extra = {}) => Object.assign({
  phonetic: '/ˈɡrɪti/',
  meanings: [{ partOfSpeech: 'adjective', definitions: [{ definition: 'covered with grit', example: 'a gritty wind' }] }]
}, extra);

test('tapping a word shows phonetics, translation and definition', async ({ page }) => {
  await openApp(page, { dict: () => ENTRY(), translate: () => 'áspero' });
  await pasteBook(page, 'L', 'A gritty wind blew.');
  await page.locator('#readerText .w', { hasText: /^gritty$/ }).click();
  await expect(page.locator('#pop .term')).toHaveText('gritty');
  await expect(page.locator('#pop .phon')).toHaveText('/ˈɡrɪti/');
  await expect(page.locator('#pop .trans')).toContainText('áspero');
  await expect(page.locator('#pop .defn')).toContainText('covered with grit');
});

test('quotes and markup from a book or an API are never injected', async ({ page }) => {
  await openApp(page, { translate: () => 'Dijo "hola" <img src=x onerror=alert(1)>' });
  await page.evaluate(() => { showPopupAt(20, 20); return lookupPhrase('He said "hi" & <b>bye</b>'); });
  await expect(page.locator('#pop .trans')).toContainText('onerror=alert(1)');
  expect(await page.locator('#pop img, #pop b').count()).toBe(0);
  // and the buttons still work with those quotes in play
  await page.locator('#pop [data-act="save"]').click();
  expect(await page.evaluate(() => DB.vocab[0].term)).toBe('He said "hi" & <b>bye</b>');
});

test('a word looked up twice costs no second request', async ({ page }) => {
  const hits = [];
  await openApp(page, { dict: () => ENTRY(), translate: () => 'áspero', onRequest: u => hits.push(u) });
  await page.evaluate(() => lookupWord('gritty'));
  expect(hits).toHaveLength(2);
  hits.length = 0;
  await page.evaluate(() => lookupWord('gritty'));
  expect(hits).toHaveLength(0);
  await expect(page.locator('#pop .trans')).toContainText('áspero');
});

test('the cache survives a reload and answers with no network at all', async ({ page, context }) => {
  await openApp(page, { dict: () => ENTRY(), translate: () => 'áspero' });
  await page.evaluate(() => lookupWord('gritty'));
  await page.reload();
  await page.waitForFunction(() => typeof idb !== 'undefined' && idb !== null);
  await context.setOffline(true);
  await page.evaluate(() => lookupWord('gritty'));
  await expect(page.locator('#pop .trans')).toContainText('áspero');
  await context.setOffline(false);
});

test('an exhausted quota is never cached as if it were a translation', async ({ page }) => {
  let mode = 'quota';
  await openApp(page, { translate: () => mode === 'quota' ? 'quota' : 'anochecer' });
  await expect(page.evaluate(() => lookupTranslation('dusk'))).rejects.toThrow();
  mode = 'ok';
  expect(await page.evaluate(() => lookupTranslation('dusk'))).toBe('anochecer');
});

test('quota, outage and being offline read differently', async ({ page }) => {
  await openApp(page, { translate: () => 'quota' });
  await page.evaluate(() => lookupWord('anything'));
  await expect(page.locator('#pop .err')).toContainText('Cuota diaria');

  await openApp(page, { translate: () => '500', dict: () => '500' });
  await page.evaluate(() => lookupWord('anything'));
  await expect(page.locator('#pop .err')).toContainText('no responde');
});

test('an inflected word is retried through its base form', async ({ page }) => {
  const asked = [];
  await openApp(page, {
    onRequest: u => { if (u.includes('dictionaryapi')) asked.push(decodeURIComponent(u.split('/').pop())); },
    dict: w => w === 'run' ? ENTRY({ phonetic: '/rʌn/' }) : '404',
    translate: () => 'corriendo'
  });
  await page.evaluate(() => lookupWord('running'));
  expect(asked[0]).toBe('running');            // the word as written comes first
  expect(asked).toContain('run');              // then its base form
  expect(asked.length).toBeLessThanOrEqual(3); // and no more than two stems are tried
  await expect(page.locator('#pop .head')).toContainText('≈ run');
  await expect(page.locator('#pop .defn')).toContainText('covered with grit');
});

test('the base forms cover regular and irregular inflections', async ({ page }) => {
  await openApp(page);
  const forms = await page.evaluate(() => ({
    running: baseForms('running'), stopped: baseForms('stopped'), studies: baseForms('studies'),
    boxes: baseForms('boxes'), making: baseForms('making'),
    went: baseForms('went'), better: baseForms('better'), children: baseForms('children'),
    house: baseForms('house')
  }));
  expect(forms.running).toContain('run');
  expect(forms.stopped).toContain('stop');
  expect(forms.studies).toContain('study');
  expect(forms.boxes).toContain('box');
  expect(forms.making).toContain('make');
  expect(forms.went[0]).toBe('go');
  expect(forms.better[0]).toBe('good');
  expect(forms.children[0]).toBe('child');
  expect(forms.house).toEqual([]);
});

test('a word the dictionary confirms it does not know is not asked for twice', async ({ page }) => {
  const asked = [];
  await openApp(page, { dict: () => '404', onRequest: u => { if (u.includes('dictionaryapi')) asked.push(u); } });
  await page.evaluate(() => lookupDict('zzzznotaword'));
  expect(asked.length).toBeGreaterThan(0);
  asked.length = 0;
  await page.evaluate(() => lookupDict('zzzznotaword'));
  expect(asked).toHaveLength(0);
});

test('an outage throws instead of being remembered as a missing word', async ({ page }) => {
  await openApp(page, { dict: () => '500' });
  const code = await page.evaluate(() => lookupDict('flaky').then(() => null, e => e.code));
  expect(code).toBe('service');
});

test('a recording is played when there is one, the synthesizer otherwise', async ({ page }) => {
  await openApp(page, { dict: () => ENTRY({ phonetics: [{ audio: '//ssl.gstatic.com/run.mp3' }] }) });
  const result = await page.evaluate(async () => {
    await lookupWord('gritty');
    let played = null, spoke = null;
    window.Audio = function (u) { played = u; return { play: () => Promise.resolve(), pause() {}, addEventListener() {} }; };
    speechSynthesis.speak = u => { spoke = u.text; };
    speechSynthesis.cancel = () => {};
    document.querySelector('#pop [data-act="speak"]').click();
    const withAudio = { played, spoke, stored: popState.audio };
    played = null; spoke = null;
    pronounce('', 'sin grabación');
    await new Promise(r => setTimeout(r, 400));
    return { withAudio, withoutAudio: { played, spoke } };
  });
  expect(result.withAudio.stored).toBe('https://ssl.gstatic.com/run.mp3');
  expect(result.withAudio.played).toBe('https://ssl.gstatic.com/run.mp3');
  expect(result.withAudio.spoke).toBeNull();
  expect(result.withoutAudio.spoke).toBe('sin grabación');
});

test('speech waits for the voice list and never speaks twice', async ({ page }) => {
  await openApp(page);
  const count = await page.evaluate(async () => {
    let n = 0;
    speechSynthesis.speak = () => { n++; };
    speechSynthesis.cancel = () => {};
    speak('once only');
    speechSynthesis.dispatchEvent(new Event('voiceschanged'));
    await new Promise(r => setTimeout(r, 450));
    return n;
  });
  expect(count).toBe(1);
});

test('a voice the engine refuses does not silence the word', async ({ page }) => {
  await openApp(page);
  const spoken = await page.evaluate(() => {
    speechSynthesis.getVoices = () => [{ lang: 'en-US', name: 'Bogus' }];   // not a real SpeechSynthesisVoice
    let said = null;
    speechSynthesis.speak = u => { said = { text: u.text, lang: u.lang }; };
    speechSynthesis.cancel = () => {};
    speak('still spoken');
    return said;
  });
  expect(spoken).toEqual({ text: 'still spoken', lang: 'en-US' });
});

test('a slow reply never overwrites the word the reader moved on to', async ({ page }) => {
  await openApp(page, { dict: () => '404', translate: t => t });
  const shown = await page.evaluate(async () => {
    const slow = lookupPhrase('the slow phrase here');
    const fast = lookupPhrase('the fast phrase here');
    await Promise.all([slow, fast]);
    return pop.querySelector('.ex').textContent;
  });
  expect(shown).toContain('fast phrase');
});

test('a dead dictionary does not hold back the translation', async ({ page }) => {
  // the dictionary hangs; the translation answers straight away.
  // Registered after openApp so this route takes priority over its stub.
  await openApp(page, { translate: () => 'polvo' });
  await page.route('**://api.dictionaryapi.dev/**', () => { /* never fulfilled */ });

  const t0 = Date.now();
  page.evaluate(() => { showPopupAt(20, 20); lookupWord('dust'); });
  await expect(page.locator('#pop .trans')).toContainText('polvo');
  expect(Date.now() - t0).toBeLessThan(4000);          // not the 6s dictionary deadline

  // the definition slot says it is still working, and the word is saveable already
  await expect(page.locator('#pop .loading')).toContainText('Buscando definición');
  await expect(page.locator('#pop [data-act="save"]')).toBeVisible();
});

test('a hanging API is abandoned instead of freezing the popup', async ({ page }) => {
  await openApp(page, { translate: () => 'polvo' });
  await page.route('**://api.dictionaryapi.dev/**', () => {});
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    await lookupWord('dust');
    return performance.now() - t0;
  });
  expect(ms).toBeGreaterThan(5500);    // it did wait for the deadline
  expect(ms).toBeLessThan(9000);       // but gave up, instead of hanging for 20s
});

test('once the dictionary is down, the next words do not pay the timeout again', async ({ page }) => {
  let asked = 0;
  await openApp(page, { translate: w => 'trad-' + w });
  await page.route('**://api.dictionaryapi.dev/**', route => { asked++; route.abort('failed'); });

  await page.evaluate(() => lookupWord('first'));
  const afterFirst = asked;

  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    await lookupWord('second');
    return performance.now() - t0;
  });
  expect(asked).toBe(afterFirst);                       // the dictionary was not contacted again
  expect(ms).toBeLessThan(3000);
  await expect(page.locator('#pop .trans')).toContainText('trad-second');   // translation still works
});

test('base forms are tried in parallel, not one after another', async ({ page }) => {
  const started = [];
  await openApp(page, { translate: () => 'corriendo' });
  await page.route('**://api.dictionaryapi.dev/**', async route => {
    const word = decodeURIComponent(route.request().url().split('/').pop());
    started.push({ word, at: Date.now() });
    await new Promise(r => setTimeout(r, 300));
    if (word === 'run') {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify([{ phonetic: '/rʌn/', meanings: [] }]) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.evaluate(() => lookupWord('running'));

  const retries = started.slice(1);                     // everything after the direct lookup
  expect(retries.length).toBeGreaterThan(1);
  const spread = Math.max(...retries.map(r => r.at)) - Math.min(...retries.map(r => r.at));
  expect(spread).toBeLessThan(150);                     // fired together, not 300ms apart
});
