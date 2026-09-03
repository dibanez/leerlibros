const { test, expect } = require('@playwright/test');
const { openApp } = require('./helpers');

/** Every request the page makes to Google. */
function watchGoogle(page) {
  const hits = [];
  page.on('request', r => { if (/googletagmanager|google-analytics/.test(r.url())) hits.push(r.url()); });
  return hits;
}

test.describe('cookie consent', () => {
  test('nothing reaches Google before the reader agrees', async ({ page }) => {
    const google = watchGoogle(page);
    await openApp(page, { consent: null });

    await expect(page.locator('#cookieBanner')).toBeVisible();
    await page.waitForTimeout(1200);
    expect(google).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).not.toMatch(/_ga/);

    // and the events are not even queued
    await page.locator('#th-dark').click();
    expect(await page.evaluate(() => (window.dataLayer || []).length)).toBe(0);
  });

  test('accepting loads Tag Manager and is remembered', async ({ page }) => {
    const google = watchGoogle(page);
    await openApp(page, { consent: null });
    await page.locator('#cookieBanner [data-arg="granted"]').click();

    await expect(page.locator('#cookieBanner')).toBeHidden();
    await expect.poll(() => google.length).toBeGreaterThan(0);
    expect(google[0]).toContain('gtm.js?id=GTM-5ZB7JTBC');
    expect(await page.evaluate(() => localStorage.getItem('ll_consent'))).toBe('granted');

    await page.locator('#th-dark').click();
    expect(await page.evaluate(() =>
      (window.dataLayer || []).some(e => e && e.ga_event === 'theme_change'))).toBe(true);
  });

  test('rejecting keeps Google out, and is not asked again', async ({ page }) => {
    const google = watchGoogle(page);
    await openApp(page, { consent: null });
    await page.locator('#cookieBanner [data-arg="denied"]').click();
    await expect(page.locator('#cookieBanner')).toBeHidden();

    await page.reload();
    await page.waitForFunction(() => typeof booksCache !== 'undefined');
    await page.waitForTimeout(1200);
    await expect(page.locator('#cookieBanner')).toBeHidden();
    expect(google).toEqual([]);
  });

  test('the choice can be changed later from Settings', async ({ page }) => {
    await openApp(page, { consent: 'granted' });
    await page.locator('#library [data-action="openReading"]').click();
    await expect(page.locator('#prefConsent [data-arg="granted"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#consentHint')).toContainText('Aceptadas');

    await page.locator('#prefConsent [data-arg="denied"]').click();
    expect(await page.evaluate(() => localStorage.getItem('ll_consent'))).toBe('denied');
    await expect(page.locator('#consentHint')).toContainText('Rechazadas');
    // reporting stops at once, without waiting for a reload
    await page.locator('[data-action="closeModal"][data-arg="readingModal"]').click();
    await page.evaluate(() => { dataLayer.length = 0; });
    await page.locator('#th-dark').click();
    expect(await page.evaluate(() =>
      (window.dataLayer || []).some(e => e && e.event === 'ga4_event'))).toBe(false);
  });

  test('there is no noscript frame loading Tag Manager behind the choice', async ({ page }) => {
    await openApp(page, { consent: null });
    const source = await page.evaluate(() => fetch('index.html').then(r => r.text()));
    expect(source).not.toContain('googletagmanager.com/ns.html');
  });
});

test.describe('translator email', () => {
  test('is stored on the device and sent to MyMemory', async ({ page }) => {
    const asked = [];
    await openApp(page, { translate: () => 'polvo', onRequest: u => { if (/mymemory/.test(u)) asked.push(u); } });

    await page.locator('#library [data-action="openReading"]').click();
    await page.fill('#prefEmail', 'lector@ejemplo.com');
    await expect.poll(() => page.evaluate(() => DB.prefs.mmEmail)).toBe('lector@ejemplo.com');
    await page.locator('[data-action="closeModal"][data-arg="readingModal"]').click();

    await page.evaluate(() => lookupTranslation('dust'));
    expect(asked.pop()).toContain('de=lector%40ejemplo.com');

    // it is a device setting, so it survives a reload and is shown back
    await page.reload();
    await page.waitForFunction(() => typeof booksCache !== 'undefined');
    await page.locator('#library [data-action="openReading"]').click();
    await expect(page.locator('#prefEmail')).toHaveValue('lector@ejemplo.com');
  });

  test('a malformed address is flagged and never sent', async ({ page }) => {
    const asked = [];
    await openApp(page, { translate: () => 'polvo', onRequest: u => { if (/mymemory/.test(u)) asked.push(u); } });
    await page.locator('#library [data-action="openReading"]').click();
    await page.fill('#prefEmail', 'esto-no-es-un-correo');
    await expect(page.locator('#prefEmail')).toHaveAttribute('aria-invalid', 'true');
    expect(await page.evaluate(() => DB.prefs.mmEmail)).toBeUndefined();

    await page.evaluate(() => lookupTranslation('dust'));
    expect(asked.pop()).not.toContain('de=');
  });

  test('the quota error offers the way to raise it', async ({ page }) => {
    await openApp(page, { translate: () => 'quota', dict: () => '404', wiktionary: () => '404' });
    await page.evaluate(() => { showPopupAt(20, 20); return lookupWord('dust'); });
    await expect(page.locator('#pop .err')).toContainText('Cuota diaria');
    await page.locator('#pop [data-act="settings"]').click();
    await expect(page.locator('#readingModal')).toBeVisible();
    await expect(page.locator('#prefEmail')).toBeVisible();
  });
});
