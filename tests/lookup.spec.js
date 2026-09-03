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
  expect(asked).toEqual(['running', 'run']);
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
