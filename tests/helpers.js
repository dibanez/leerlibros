const { expect } = require('@playwright/test');

const TODAY = () => new Date().toISOString().slice(0, 10);
const PLUS = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

/**
 * Opens the app on a clean profile with every external call stubbed, so the
 * suite never depends on the network or on a third party being up.
 *
 * @param {object} opts
 *  - dict:      (word) => entry|null|'404'|'500'   dictionary API reply
 *  - wiktionary:(word) => {en:[...]}|null|'404'|'500'  fallback dictionary reply
 *  - translate: (text) => string|'quota'|'500'     translation API reply
 *  - onRequest: (url) => void                      called for every stubbed API hit
 */
async function openApp(page, opts = {}) {
  const { dict, translate, wiktionary, onRequest } = opts;

  // Analytics must never be contacted from a test.
  await page.route('**://www.googletagmanager.com/**', route => route.abort());

  await page.route('**://api.dictionaryapi.dev/**', async route => {
    const word = decodeURIComponent(route.request().url().split('/').pop());
    if (onRequest) onRequest(route.request().url());
    const reply = dict ? dict(word) : null;
    if (reply === '500') return route.fulfill({ status: 503, body: '{}' });
    if (!reply || reply === '404') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([reply]) });
  });

  await page.route('**://en.wiktionary.org/**', async route => {
    const word = decodeURIComponent(route.request().url().split('/').pop());
    if (onRequest) onRequest(route.request().url());
    const reply = wiktionary ? wiktionary(word) : null;
    if (reply === '500') return route.fulfill({ status: 503, body: '{}' });
    if (!reply || reply === '404') return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reply) });
  });

  await page.route('**://api.mymemory.translated.net/**', async route => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (onRequest) onRequest(route.request().url());
    const reply = translate ? translate(q) : null;
    if (reply === '500') return route.fulfill({ status: 503, body: '{}' });
    const text = reply === 'quota'
      ? 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY'
      : (reply || 'traducción de ' + q);
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ responseData: { translatedText: text } })
    });
  });

  await page.goto('/index.html');
  await page.evaluate(async () => {
    localStorage.clear();
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    for (const k of await caches.keys()) await caches.delete(k);
    await new Promise(res => { const rq = indexedDB.deleteDatabase('leerlibros'); rq.onsuccess = rq.onerror = rq.onblocked = res; });
  });
  await page.reload();
  await page.waitForFunction(() => typeof booksCache !== 'undefined' && typeof idb !== 'undefined');
}

/** Adds a book by pasting text, and opens it. */
async function pasteBook(page, title, text) {
  await page.evaluate(([t, body]) => {
    document.getElementById('pasteTitle').value = t;
    document.getElementById('pasteText').value = body;
    savePaste();
  }, [title, text]);
  await expect(page.locator('#reader')).toBeVisible();
}

/** Builds an EPUB in the page and imports it. `kind` picks EPUB 3 nav or EPUB 2 NCX. */
async function importEpub(page, kind) {
  await page.evaluate(async (k) => {
    const JSZipLib = await loadJSZip();
    const z = new JSZipLib();
    z.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const ids = ['cover', 'c1', 'c2'];
    ids.forEach((id, i) => z.file('OEBPS/' + id + '.xhtml',
      '<html xmlns="http://www.w3.org/1999/xhtml"><body><div class="wrap"><p>Body of section ' + i +
      ', long enough to clear the forty character filter used on import.</p></div></body></html>'));
    const manifest = ids.map(id => `<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`).join('');
    const spine = ids.map(id => `<itemref idref="${id}"/>`).join('');
    if (k === 'epub3') {
      z.file('OEBPS/nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>' +
        '<li><a href="c1.xhtml">El Comienzo</a></li><li><a href="./c2.xhtml#frag">El Desenlace</a></li></ol></nav></body></html>');
      z.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Novela EPUB3</dc:title></metadata><manifest>' +
        manifest + '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine>' + spine + '</spine></package>');
    } else {
      z.file('OEBPS/toc.ncx', '<?xml version="1.0"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>' +
        '<navPoint><navLabel><text>El Comienzo</text></navLabel><content src="c1.xhtml"/></navPoint>' +
        '<navPoint><navLabel><text>El Desenlace</text></navLabel><content src="c2.xhtml#p1"/></navPoint></navMap></ncx>');
      z.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Novela EPUB2</dc:title></metadata><manifest>' +
        manifest + '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">' + spine + '</spine></package>');
    }
    await loadEpub(new File([await z.generateAsync({ type: 'blob' })], k + '.epub'), 'fallback');
  }, kind);
  await expect(page.locator('#reader')).toBeVisible();
}

/** Reads every book row straight out of IndexedDB, bypassing the in-memory cache. */
function booksOnDisk(page) {
  return page.evaluate(() => new Promise(res => {
    const rq = indexedDB.open('leerlibros', 2);
    rq.onsuccess = () => {
      const g = rq.result.transaction('books', 'readonly').objectStore('books').getAll();
      g.onsuccess = () => { rq.result.close(); res(g.result); };
    };
  }));
}

/** Runs exportLibrary() and returns the JSON it would have downloaded. */
function exportedBackup(page) {
  return page.evaluate(() => {
    let captured = null;
    const real = downloadBlob;
    window.downloadBlob = b => { captured = b; };
    exportLibrary();
    window.downloadBlob = real;
    return captured ? captured.text() : null;
  });
}

module.exports = { openApp, pasteBook, importEpub, booksOnDisk, exportedBackup, TODAY, PLUS };
