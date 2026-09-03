/* Google Tag Manager. Kept in its own file so the page needs no inline script,
   and loaded only once the reader has accepted analytics cookies: nothing is
   requested from Google, and no cookie is set, before that. */
const GTM_ID = 'GTM-5ZB7JTBC';
let gtmLoaded = false;

window.loadGTM = function loadGTM() {
  if (gtmLoaded) return;
  gtmLoaded = true;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  const first = document.getElementsByTagName('script')[0];
  const tag = document.createElement('script');
  tag.async = true;
  tag.src = 'https://www.googletagmanager.com/gtm.js?id=' + GTM_ID;
  first.parentNode.insertBefore(tag, first);
};

// app.js runs before this deferred script, so the choice is already known
if (window.llConsent && window.llConsent() === 'granted') window.loadGTM();
