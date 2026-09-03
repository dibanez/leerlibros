const { test, expect } = require('@playwright/test');
const { openApp } = require('./helpers');

test('the page declares what search engines and social networks need', async ({ page }) => {
  await openApp(page);
  const meta = n => page.getAttribute(`meta[${n}]`, 'content');
  expect((await meta('name="description"')).length).toBeGreaterThan(80);
  expect((await meta('name="description"')).length).toBeLessThan(165);
  expect(await page.getAttribute('link[rel=canonical]', 'href')).toBe('https://dibanez.github.io/leerlibros/');
  expect(await meta('property="og:image"')).toMatch(/\/og-image\.png$/);
  expect(await meta('property="og:image:width"')).toBe('1200');
  expect(await meta('name="twitter:card"')).toBe('summary_large_image');

  const ld = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
  expect(ld['@type']).toBe('SoftwareApplication');
  expect(ld.offers.price).toBe('0');
});

test('the social image is really 1200x630', async ({ page }) => {
  await openApp(page);
  const size = await page.evaluate(() => new Promise(res => {
    const img = new Image();
    img.onload = () => res(img.naturalWidth + 'x' + img.naturalHeight);
    img.onerror = () => res('missing');
    img.src = 'og-image.png';
  }));
  expect(size).toBe('1200x630');
});

test('the manifest is installable and keeps the existing app identity', async ({ page }) => {
  await openApp(page);
  const mf = await page.evaluate(() => fetch('manifest.webmanifest').then(r => r.json()));
  expect(mf.start_url).toBe('./');
  expect(mf.id).toBe('/leerlibros/index.html');   // pinned: changing it would orphan installs
  expect(mf.orientation).toBeUndefined();          // portrait is not forced any more
  expect(mf.icons.some(i => i.purpose === 'maskable')).toBe(true);
  expect(mf.screenshots.map(s => s.form_factor).sort()).toEqual(['narrow', 'wide']);

  for (const shot of mf.screenshots) {
    const size = await page.evaluate(src => new Promise(res => {
      const img = new Image();
      img.onload = () => res(img.naturalWidth + 'x' + img.naturalHeight);
      img.onerror = () => res('missing');
      img.src = src;
    }), shot.src);
    expect(size).toBe(shot.sizes);
  }
});

test('nothing inline is left, so the CSP can stay strict', async ({ page }) => {
  const violations = [];
  await page.on('console', m => { if (/Content Security Policy/i.test(m.text())) violations.push(m.text()); });
  await openApp(page);
  await page.evaluate(() => { openVocab(); closeModal('vocabModal'); openPaste(); closeModal('pasteModal'); });

  expect(await page.locator('[onclick], [onchange], [onload]').count()).toBe(0);
  expect(await page.locator('style').count()).toBe(0);
  expect(violations).toEqual([]);

  // The served markup must carry no inline handler and no style attribute.
  // (The live DOM does have style attributes: setting el.style.x through the
  // CSSOM creates one, and the CSP allows that.)
  const source = await page.evaluate(() => fetch('index.html').then(r => r.text()));
  expect(source).not.toMatch(/\son[a-z]+\s*=\s*"/);
  expect(source).not.toContain('style="');

  const csp = await page.getAttribute('meta[http-equiv="Content-Security-Policy"]', 'content');
  expect(csp).toContain("script-src 'self' https://www.googletagmanager.com");
  expect(csp).toContain("style-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
});

test('every button works through data-action, with no inline handler', async ({ page }) => {
  await openApp(page);
  await page.locator('[data-action="theme"][data-arg="dark"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'dark');
  await page.locator('[data-action="openPaste"]').click();
  await expect(page.locator('#pasteModal')).toBeVisible();
  await page.locator('[data-action="closeModal"][data-arg="pasteModal"]').click();
  await expect(page.locator('#pasteModal')).toBeHidden();
  await page.locator('[data-action="openVocab"]').click();
  await expect(page.locator('#vocabModal')).toBeVisible();
});

test('JSZip ships with the app and loads only when an EPUB arrives', async ({ page }) => {
  await openApp(page);
  expect(await page.evaluate(() => typeof window.JSZip)).toBe('undefined');
  expect(await page.locator('script[src*="jszip"]').count()).toBe(0);
  const blocking = await page.evaluate(() =>
    [...document.querySelectorAll('head script[src]')].filter(s => !s.async && !s.defer).map(s => s.src));
  expect(blocking).toEqual([]);

  await page.evaluate(() => loadJSZip());
  const src = await page.getAttribute('script[src*="jszip"]', 'src');
  expect(src).toBe('vendor/jszip.min.js');       // same origin, no CDN
  expect(await page.evaluate(() => typeof window.JSZip)).toBe('function');
});

test('a published change reaches the reader on the first reload', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.register('sw.js'));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => caches.keys().then(k => k.length))).toBeGreaterThan(0);

  // the page is fetched from the network first, so a new deploy is not shadowed
  await page.reload();
  await page.waitForFunction(() => typeof booksCache !== 'undefined');
  const fromNetwork = await page.evaluate(() =>
    performance.getEntriesByType('navigation')[0].transferSize > 0 ||
    !!performance.getEntriesByType('navigation')[0].responseStart);
  expect(fromNetwork).toBe(true);
});

test('the app still opens with the network gone', async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.register('sw.js'));
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => caches.open('leerlibros-v11').then(c => c.keys()).then(k => k.length))).toBeGreaterThan(5);

  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#library')).toBeVisible();
  expect(await page.evaluate(() => typeof booksCache)).toBe('object');
  // the vendored JSZip is cached too, so EPUBs still import offline
  expect(await page.evaluate(() => caches.match('vendor/jszip.min.js').then(r => !!r))).toBe(true);
  await context.setOffline(false);
});
