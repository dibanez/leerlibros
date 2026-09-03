/* LeerLibros dataLayer instrumentation.
   Listens to DOM events only: it never touches the application code.
   The GTM tag "GA4 - Eventos LeerLibros" reads ga_event as the event name
   and everything else as parameters. */
(function () {
  window.dataLayer = window.dataLayer || [];

  // Book titles, looked-up words and selected phrases are the reader's own
  // content. Set this to false to keep counting the events without them.
  const TRACK_CONTENT = true;
  const content = value => (TRACK_CONTENT ? value : undefined);
  // read by the test suite, so the gate is checked in whichever mode ships
  window.llTrackContent = TRACK_CONTENT;

  // Parameters left over from an earlier push would stick to the next event,
  // so they are cleared before every push.
  const PARAMS = ['method', 'format', 'book_title', 'direction', 'page_num',
                  'word', 'theme', 'minutes', 'label'];

  function track(name, params) {
    const clear = {};
    PARAMS.forEach(k => { clear[k] = undefined; });
    dataLayer.push(clear);
    const event = { event: 'ga4_event', ga_event: name };
    if (params) {
      for (const k in params) {
        if (params[k] !== undefined && params[k] !== '') event[k] = params[k];
      }
    }
    dataLayer.push(event);
  }
  window.llTrack = track;   // available for manual calls

  const $ = id => document.getElementById(id);
  const tx = el => ((el && el.textContent) || '').trim();
  const vis = el => !!el && getComputedStyle(el).display !== 'none';
  const ext = n => (String(n).split('.').pop() || '').toLowerCase();
  const cut = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n || 80);

  // The reader shows a chapter picker, not a "page 3 of 40" label.
  function chapterNum() {
    const sel = $('chapSel');
    return sel && sel.options.length ? sel.selectedIndex + 1 : '';
  }
  // Clicks are captured before the app handles them, so the picker still holds
  // the old section: read it on the next tick to report where the reader landed.
  function trackPageTurn(direction) {
    setTimeout(() => track('page_turn', { direction, page_num: chapterNum() }), 0);
  }

  /* ---------- CLICKS ---------- */
  document.addEventListener('click', function (e) {
    const t = e.target && e.target.closest
      ? e.target.closest('button, a, [role=button], .bookcard, #booklist > *')
      : null;
    if (!t) return;
    const id = t.id || '';
    const lb = cut(t.innerText, 60);

    if (id === 'th-light' || id === 'th-sepia' || id === 'th-dark') return track('theme_change', { theme: id.slice(3) });
    if (id === 'installBtn') return track('pwa_install_click');
    if (id === 'donateBtn') return track('donate_click', { method: 'paypal' });
    if (id === 'nextBtn') return trackPageTurn('next');
    if (id === 'prevBtn') return trackPageTurn('prev');
    if (id === 'selBtn') return track('phrase_translate', {
      label: content(cut(String(window.getSelection() || ''), 90))
    });
    if (/^A[−\-]$/.test(lb)) return track('font_size', { direction: 'down' });
    if (/^A\+$/.test(lb)) return track('font_size', { direction: 'up' });
    if (/Siguiente/i.test(lb)) return trackPageTurn('next');
    if (/Anterior/i.test(lb)) return trackPageTurn('prev');
    if (/Pegar texto/i.test(lb)) return track('add_book_start', { method: 'paste' });
    if (/Subir .*(txt|epub)/i.test(lb)) return track('add_book_start', { method: 'upload' });
    if (/Guardar y leer/i.test(lb)) return track('book_add', {
      method: 'paste', format: 'txt',
      book_title: content(cut(($('pasteTitle') || {}).value || '(sin título)'))
    });
    if (/Vocabulario/i.test(lb)) return track('vocab_open');
    if (/CSV/i.test(lb)) return track('vocab_export', { format: 'csv' });
    if (/Vaciar/i.test(lb)) return track('vocab_clear');
    if (t.closest('#pop')) {
      // data-act is a stable identifier; the visible text carries an emoji and
      // would split the reports in two the day it changes
      const act = t.dataset.act || (t.closest('[data-act]') || {}).dataset?.act;
      if (act === 'speak') return;          // reported as its own 'speak' event
      return track('word_action', { label: act || 'other', word: content(window.__llWord) });
    }

    if (t.closest('#booklist')) {
      // a card opens with the ✕ delete button, so its own text is not the title
      const card = t.closest('.bookcard');
      const title = cut(tx(card && card.querySelector('.title')));
      return track(t.classList.contains('del') ? 'book_delete' : 'book_select', { book_title: content(title) });
    }
  }, true);

  /* ---------- FILE UPLOADS ---------- */
  document.addEventListener('change', function (e) {
    const el = e.target;
    if (el && el.type === 'file' && el.files && el.files.length) {
      for (const file of el.files) {
        track('book_add', { method: 'upload', format: ext(file.name), book_title: content(cut(file.name)) });
      }
    }
  }, true);

  /* ---------- DRAG AND DROP ---------- */
  document.addEventListener('drop', function (e) {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    for (const file of files) {
      track('book_add', { method: 'drop', format: ext(file.name), book_title: content(cut(file.name)) });
    }
  }, true);

  /* ---------- WORD LOOKUP (the #pop popup) ---------- */
  const pop = $('pop');
  if (pop && window.MutationObserver) {
    let last = '';
    new MutationObserver(function () {
      if (!vis(pop)) { last = ''; return; }
      // the looked-up word lives in .term; anything else is chrome
      const word = cut(tx(pop.querySelector('.term')), 40).toLowerCase();
      if (word && word !== last) {
        last = word;
        window.__llWord = word;
        track('word_lookup', { word: content(word) });
      }
    }).observe(pop, {
      attributes: true, childList: true, subtree: true,
      attributeFilter: ['style', 'class', 'hidden']
    });
  }

  /* ---------- READER OPEN / CLOSE, AND TIME SPENT ---------- */
  const reader = $('reader');
  let wasOpen = vis(reader), secs = 0, hits = {};
  if (reader && window.MutationObserver) {
    new MutationObserver(function () {
      const now = vis(reader);
      if (now && !wasOpen) {
        secs = 0; hits = {};
        track('reader_open', { book_title: content(cut(tx($('readerTitle')))) });
      }
      // to one decimal: whole minutes reported every session under 30s as 0,
      // and made 40s and 80s indistinguishable
      if (!now && wasOpen) track('reader_close', { minutes: Math.round(secs / 6) / 10 });
      wasOpen = now;
    }).observe(reader, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  }
  setInterval(function () {
    if (!vis(reader) || document.hidden) return;
    secs += 15;
    [1, 5, 10, 20, 30].forEach(function (m) {
      if (secs >= m * 60 && !hits[m]) { hits[m] = 1; track('reading_time', { minutes: m }); }
    });
  }, 15000);

  /* ---------- PWA ---------- */
  window.addEventListener('beforeinstallprompt', () => track('pwa_install_available'));
  window.addEventListener('appinstalled', () => track('pwa_installed'));
  if (window.matchMedia && matchMedia('(display-mode: standalone)').matches) track('app_open_standalone');

  /* ---------- JS ERRORS ---------- */
  window.addEventListener('error', function (ev) {
    track('js_error', { label: cut((ev && ev.message) || 'error', 90) });
  });
})();
