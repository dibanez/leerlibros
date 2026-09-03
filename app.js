/* ============ STORAGE ============ */
// Corrupt or unreadable storage must never break startup: fall back to defaults.
function readJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    if(!raw) return fallback;
    const val = JSON.parse(raw);
    if(Array.isArray(fallback) !== Array.isArray(val)) return fallback;
    return (val && typeof val === 'object') ? val : fallback;
  }catch(err){
    console.warn('Unreadable storage for', key, err);
    return fallback;
  }
}
// Writes fail loudly (quota exceeded) instead of losing data silently.
function writeJSON(key, value){
  try{
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  }catch(err){
    console.error('Storage write failed for', key, err);
    toast('No se pudo guardar: almacenamiento lleno. Borra algún libro.');
    return false;
  }
}
const DB = {
  get vocab(){ return readJSON('ll_vocab', []); },
  set vocab(v){ writeJSON('ll_vocab', v); },
  get prefs(){ return readJSON('ll_prefs', {}); },
  set prefs(v){ writeJSON('ll_prefs', v); },
  get stats(){ return readJSON('ll_stats', {}); },
  set stats(v){ writeJSON('ll_stats', v); },
};
let current = null; // current book being read

/* ============ BOOK STORE (IndexedDB) ============ */
// One book can be megabytes of text, far past the localStorage quota, so the
// library lives in IndexedDB. It is mirrored in memory to keep the rendering
// code synchronous; writes go to disk in the background and report failures.
const IDB_NAME = 'leerlibros';
const IDB_VERSION = 2;
const IDB_STORE = 'books';
const IDB_LOOKUPS = 'lookups';
let booksCache = [];  // the library as shown, newest first
let idb = null;       // null when IndexedDB is unusable -> localStorage fallback

function openIDB(){
  return new Promise(resolve=>{
    let req;
    try{ req = indexedDB.open(IDB_NAME, IDB_VERSION); }
    catch(err){ console.warn('IndexedDB unavailable', err); return resolve(null); }
    req.onupgradeneeded = ()=>{
      const db = req.result;
      if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath:'id' });
      if(!db.objectStoreNames.contains(IDB_LOOKUPS)) db.createObjectStore(IDB_LOOKUPS, { keyPath:'key' });
    };
    req.onsuccess = ()=>{
      const db = req.result;
      db.onversionchange = ()=>db.close();
      resolve(db);
    };
    req.onerror = ()=>resolve(null);
    req.onblocked = ()=>resolve(null);
  });
}

function idbTx(store, mode, run){
  return new Promise((resolve, reject)=>{
    if(!idb) return reject(new Error('IndexedDB unavailable'));
    let tx, req;
    try{
      tx = idb.transaction(store, mode);
      req = run(tx.objectStore(store));
    }catch(err){ return reject(err); }
    tx.oncomplete = ()=>resolve(req ? req.result : undefined);
    tx.onerror = ()=>reject(tx.error);
    tx.onabort = ()=>reject(tx.error);
  });
}

function sortBooks(){ booksCache.sort((a,b)=>(b.added||0)-(a.added||0)); }

// Books imported before sections were capped keep chapters of 50 KB, which is
// dozens of screens with no way back. They are re-cut once, and the reader is
// left as close as possible to where they had got to.
function resplitBook(b){
  const oldPos = Math.min(b.pos || 0, b.chapters.length - 1);
  const offset = b.chapters.slice(0, oldPos).reduce((n,c)=>n + c.length, 0) +
                 Math.round((b.scroll || 0) * (b.chapters[oldPos] || '').length);

  const chapters = [], titles = [];
  b.chapters.forEach((text, i)=>{
    for(const part of splitIntoSections(text, (b.titles||[])[i] || '')){
      chapters.push(part.text); titles.push(part.title);
    }
  });
  if(!chapters.length) return false;

  let acc = 0, pos = 0;
  for(let i = 0; i < chapters.length; i++){
    pos = i;
    if(acc + chapters[i].length > offset) break;
    acc += chapters[i].length;
  }
  b.chapters = chapters;
  b.titles = titles;
  b.pos = pos;
  b.scroll = 0;
  b.resplit = 1;
  return true;
}

async function resplitOldBooks(){
  const stale = booksCache.filter(b=>
    !b.resplit && b.chapters.some(c=>c.length > SECTION_LIMIT * 2));
  if(!stale.length) return;
  const changed = stale.filter(resplitBook);
  if(!changed.length) return;
  try{
    if(idb) await idbTx(IDB_STORE, 'readwrite', s=>{ changed.forEach(b=>s.put(b)); });
    else writeJSON('ll_books', booksCache);
    console.info('Re-cut '+changed.length+' book(s) into readable sections');
  }catch(err){ console.error('Could not store the re-cut books', err); }
}

// Persist one book, or a deletion when removedId is given.
function persistBook(book, removedId){
  const done = idb
    ? idbTx(IDB_STORE, 'readwrite', s=> removedId ? s.delete(removedId) : s.put(book))
    : Promise.resolve(writeJSON('ll_books', booksCache));
  return done.catch(err=>{
    console.error('Book save failed', err);
    toast('No se pudo guardar la biblioteca.');
  });
}

async function initBooks(){
  idb = await openIDB();
  if(idb){
    try{ booksCache = (await idbTx(IDB_STORE, 'readonly', s=>s.getAll())) || []; }
    catch(err){ console.error('IndexedDB read failed', err); idb = null; }
  }
  const legacy = readJSON('ll_books', []);
  if(!idb){
    booksCache = legacy;  // fallback: keep working straight off localStorage
  } else if(legacy.length){
    // One-time migration of a library written by the localStorage version.
    const known = new Set(booksCache.map(b=>b.id));
    const base = Date.now();
    const incoming = legacy
      .filter(b=>b && typeof b === 'object' && !known.has(b.id))
      .map((b,i)=>Object.assign({ added: base-i }, b));
    try{
      if(incoming.length) await idbTx(IDB_STORE, 'readwrite', s=>{ incoming.forEach(b=>s.put(b)); });
      booksCache = booksCache.concat(incoming);
      localStorage.removeItem('ll_books');  // dropped only once safely copied
    }catch(err){ console.error('Library migration failed', err); }
  }
  booksCache.forEach(b=>{
    if(!b.added) b.added = 0;
    if(!Array.isArray(b.titles) || b.titles.length !== b.chapters.length){
      b.titles = b.chapters.map(headingOf);
    }
  });
  await resplitOldBooks();
  sortBooks();
}

/* ============ CONSENT ============ */
// No analytics cookie is set before the reader agrees: gtm.js waits for this,
// and analytics.js reports nothing without it.
const CONSENT_KEY = 'll_consent';

function llConsent(){
  try{ return localStorage.getItem(CONSENT_KEY); }catch(err){ return null; }
}
window.llConsent = llConsent;

function dropAnalyticsCookies(){
  document.cookie.split(';').forEach(entry=>{
    const name = entry.split('=')[0].trim();
    if(!/^_ga/.test(name)) return;
    document.cookie = name+'=; Max-Age=0; path=/';
    document.cookie = name+'=; Max-Age=0; path=/; domain='+location.hostname;
    document.cookie = name+'=; Max-Age=0; path=/; domain=.'+location.hostname;
  });
}

function setConsent(value){
  try{ localStorage.setItem(CONSENT_KEY, value); }catch(err){}
  document.getElementById('cookieBanner').classList.add('hidden');
  paintConsent();
  if(value === 'granted'){
    if(window.loadGTM) window.loadGTM();
    toast('Gracias, se han activado las estadísticas');
  }else{
    dropAnalyticsCookies();
    toast('Sin cookies de análisis');
  }
}

function paintConsent(){
  const choice = llConsent();
  const group = document.getElementById('prefConsent');
  if(group){
    [...group.querySelectorAll('button')].forEach(b=>{
      const on = b.dataset.arg === choice;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  const hint = document.getElementById('consentHint');
  if(hint){
    hint.textContent = choice === 'granted'
      ? 'Aceptadas. Google Analytics mide cómo se usa la app; puedes rechazarlas cuando quieras.'
      : choice === 'denied'
        ? 'Rechazadas. No se carga Google Analytics ni se guarda ninguna cookie suya.'
        : 'Aún no has elegido. Mientras tanto no se carga Google Analytics.';
  }
}

// Asked once, on the first visit
if(!llConsent()) document.getElementById('cookieBanner').classList.remove('hidden');
paintConsent();

/* ============ THEME & FONT ============ */
function setTheme(t){
  document.body.dataset.theme = t;
  ['light','sepia','dark'].forEach(x=>document.getElementById('th-'+x).classList.toggle('on', x===t));
  const p = DB.prefs; p.theme = t; DB.prefs = p;
}
function changeFont(d){
  const p = DB.prefs; p.fs = Math.min(34, Math.max(14, (p.fs||20)+d*2)); DB.prefs = p;
  document.documentElement.style.setProperty('--fs', p.fs+'px');
}

// Long reading sessions live or die on these three.
const READER_FONTS = {
  serif:   "'Georgia', 'Times New Roman', serif",
  sans:    "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  legible: "Verdana, Tahoma, 'DejaVu Sans', sans-serif"
};
function applyReading(p){
  const root = document.documentElement.style;
  root.setProperty('--fs', (p.fs || 20)+'px');
  root.setProperty('--lh', String(p.lh || 1.75));
  root.setProperty('--measure', (p.width || 820)+'px');
  root.setProperty('--reader-font', READER_FONTS[p.font] || READER_FONTS.serif);
  markReadingChoices(p);
}
function markReadingChoices(p){
  const on = (groupId, value)=>{
    const group = document.getElementById(groupId);
    if(!group) return;
    [...group.querySelectorAll('button')].forEach(b=>{
      const active = b.dataset.arg.split(':')[1] === String(value);
      b.classList.toggle('on', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };
  on('prefFont', p.font || 'serif');
  on('prefLh', p.lh || 1.75);
  on('prefWidth', p.width || 820);
  on('prefNew', newPerDay());
  on('prefSession', sessionCap());
}
// data-arg is "key:value"
function setReadingPref(arg){
  const [key, raw] = String(arg).split(':');
  const p = DB.prefs;
  p[key] = key === 'font' ? raw : Number(raw);
  DB.prefs = p;
  applyReading(p);
}
function openReading(){
  markReadingChoices(DB.prefs);
  document.getElementById('prefEmail').value = DB.prefs.mmEmail || '';
  document.getElementById('prefExercise').value = DB.prefs.revMode || 'mixed';
  paintConsent();
  openModal('readingModal');
}

(function initPrefs(){
  const p = DB.prefs;
  setTheme(p.theme||'light');
  applyReading(p);
})();

/* ============ TOAST ============ */
let toastT;
function toast(msg){
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(()=>el.classList.remove('show'), 1900);
}

/* ============ LIBRARY ============ */
function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,7); }

function renderLibrary(){
  const list = document.getElementById('booklist');
  const books = booksCache;
  list.innerHTML = '';
  document.getElementById('libEmpty').classList.toggle('hidden', books.length>0);
  books.forEach(b=>{
    const prog = b.chapters.length>1 ? Math.round((b.pos||0)/(b.chapters.length-1)*100) : (b.pos? 100:0);
    const card = document.createElement('div');
    card.className = 'bookcard';
    card.onclick = ()=>openBook(b.id);
    card.innerHTML = `
      <button class="del" title="Eliminar">✕</button>
      <div class="title">${esc(b.title)}</div>
      <div class="meta">${b.chapters.length} ${b.chapters.length===1?'sección':'secciones'} · ${b.words||0} palabras</div>
      <div class="prog"><i></i></div>
    `;
    card.querySelector('.prog i').style.width = prog + '%';   // CSSOM, not an inline attribute
    card.querySelector('.del').addEventListener('click', e=>{ e.stopPropagation(); deleteBook(b.id); });
    list.appendChild(card);
  });
}

function deleteBook(id){
  if(!confirm('¿Eliminar este libro de tu biblioteca?')) return;
  booksCache = booksCache.filter(b=>b.id!==id);
  persistBook(null, id);
  renderLibrary();
}

// Pasted text and .txt files go through the same cutting as an EPUB, so a
// "## Heading" names its section there too instead of landing mid-section.
function saveBookFromText(title, text){
  const parts = splitIntoSections(text, '');
  return saveBook(title, parts.map(p=>p.text), parts.map(p=>p.title));
}

function saveBook(title, chapters, titles){
  const words = chapters.join(' ').split(/\s+/).filter(Boolean).length;
  const named = (titles && titles.length === chapters.length) ? titles : chapters.map(headingOf);
  const book = { id:uid(), title:title||'Sin título', chapters, titles:named, pos:0, scroll:0, words, added:Date.now() };
  booksCache.unshift(book);
  persistBook(book);
  renderLibrary();
  return book;
}

/* ============ FILE / EPUB LOADING ============ */
function handleFiles(files){
  [...files].forEach(f=>{
    const name = f.name.replace(/\.(txt|epub)$/i,'');
    if(/\.epub$/i.test(f.name)) loadEpub(f, name);
    else if(/\.txt$/i.test(f.name)){
      const r = new FileReader();
      r.onload = ()=>{ const b=saveBookFromText(name, r.result); openBook(b.id); };
      r.readAsText(f);
    } else toast('Formato no soportado: '+f.name);
  });
}

// JSZip is only needed to open an EPUB, so it is fetched on first use instead
// of blocking every page load. It ships with the app rather than coming from a
// CDN: one less third party to trust, to reach, and to allow in the CSP.
const JSZIP_URL = 'vendor/jszip.min.js';
let jszipLoading = null;

function loadJSZip(){
  if(window.JSZip) return Promise.resolve(window.JSZip);
  if(!jszipLoading){
    jszipLoading = new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = JSZIP_URL;
      s.onload = ()=> window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip loaded but is missing'));
      s.onerror = ()=>{ jszipLoading = null; reject(new Error('No se pudo cargar el lector de EPUB')); };
      document.head.appendChild(s);
    });
  }
  return jszipLoading;
}

async function loadEpub(file, fallbackTitle){
  try{
    toast('Procesando EPUB…');
    const JSZipLib = await loadJSZip();
    const zip = await JSZipLib.loadAsync(file);
    // 1. find OPF via container.xml
    const containerXml = await zip.file('META-INF/container.xml').async('string');
    const cdoc = new DOMParser().parseFromString(containerXml, 'application/xml');
    const opfPath = cdoc.querySelector('rootfile').getAttribute('full-path');
    const opfDir = opfPath.includes('/') ? opfPath.replace(/\/[^/]*$/, '/') : '';
    const opfXml = await zip.file(opfPath).async('string');
    const opf = new DOMParser().parseFromString(opfXml, 'application/xml');
    // title
    const titleEl = opf.querySelector('metadata title, title');
    const title = (titleEl && titleEl.textContent.trim()) || fallbackTitle;
    // manifest id->href
    const manifest = {};
    opf.querySelectorAll('manifest item').forEach(it=>{
      manifest[it.getAttribute('id')] = it.getAttribute('href');
    });
    // chapter names, so sections are not just numbers
    const tocTitles = await readToc(zip, opf, manifest, opfDir);
    // spine order
    const spine = [...opf.querySelectorAll('spine itemref')].map(ir=>ir.getAttribute('idref'));
    const chapters = [], titles = [];
    for(const idref of spine){
      let href = manifest[idref];
      if(!href) continue;
      const full = decodeURIComponent(opfDir + href);
      const fileObj = zip.file(full) || zip.file(href);
      if(!fileObj) continue;
      const html = await fileObj.async('string');
      const text = htmlToText(html);
      if(text.trim().length>40){
        // the TOC names the file; the headings inside name each chapter
        for(const part of splitIntoSections(text, tocTitles[normHref(href)])){
          chapters.push(part.text);
          titles.push(part.title);
        }
      }
    }
    if(!chapters.length){ toast('No se pudo extraer texto del EPUB'); return; }
    const b = saveBook(title, chapters, titles);
    openBook(b.id);
  }catch(e){
    console.error(e);
    toast('Error leyendo el EPUB: '+e.message);
  }
}

// One EPUB file often holds several chapters and can run to 60 KB, which on a
// phone is dozens of screens with no way back. It is cut at its own chapter
// headings first -- that also recovers the chapters a table of contents only
// points at by fragment -- and whatever is still too long is capped.
function splitIntoSections(text, fallbackTitle){
  const out = [];
  const blocks = String(text).replace(/\r\n/g, '\n').split(/\n\n(?=## )/);
  for(const block of blocks){
    const heading = headingOf(block);
    const title = heading || (out.length ? '' : (fallbackTitle || ''));
    const pieces = splitChapters(block);
    pieces.forEach((piece, i)=>{
      let label = title;
      if(pieces.length > 1) label = title ? title+' · '+(i+1)+'/'+pieces.length : '';
      out.push({ text: piece, title: label });
    });
  }
  return out;
}

function normHref(h){ return decodeURIComponent((h||'').split('#')[0].replace(/^\.\//, '')); }

// A chapter with no entry in the table of contents can still take its name
// from its own first heading.
function headingOf(text){
  const first = (text.split('\n')[0]||'').trim();
  return first.startsWith('## ') ? first.slice(3).trim() : '';
}

// Chapter titles come from the EPUB 3 nav document or, failing that, from the
// EPUB 2 NCX. Returns a map of spine href -> title; empty when neither exists.
async function readToc(zip, opf, manifest, opfDir){
  const map = {};
  const readFile = async href=>{
    const f = zip.file(decodeURIComponent(opfDir + href)) || zip.file(decodeURIComponent(href));
    return f ? f.async('string') : null;
  };
  try{
    // EPUB 3: the manifest item flagged properties="nav"
    const navItem = [...opf.querySelectorAll('manifest item')]
      .find(it=>(it.getAttribute('properties')||'').split(/\s+/).includes('nav'));
    if(navItem){
      const xml = await readFile(navItem.getAttribute('href'));
      if(xml){
        const doc = new DOMParser().parseFromString(xml, 'text/html');
        const navs = [...doc.querySelectorAll('nav')];
        const nav = navs.find(n=>/toc/i.test(n.getAttribute('epub:type')||n.getAttribute('type')||'')) || navs[0];
        if(nav) nav.querySelectorAll('a[href]').forEach(a=>{
          const t = a.textContent.replace(/\s+/g,' ').trim();
          const h = normHref(a.getAttribute('href'));
          if(t && h && !map[h]) map[h] = t;
        });
      }
    }
    // EPUB 2: <spine toc="ncx"> points at the NCX through the manifest
    if(!Object.keys(map).length){
      const spineEl = opf.querySelector('spine');
      const ncxHref = spineEl ? manifest[spineEl.getAttribute('toc')] : null;
      const xml = ncxHref ? await readFile(ncxHref) : null;
      if(xml){
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        doc.querySelectorAll('navPoint').forEach(np=>{
          const label = np.querySelector('navLabel text');
          const content = np.querySelector('content');
          if(!label || !content) return;
          const t = label.textContent.replace(/\s+/g,' ').trim();
          const h = normHref(content.getAttribute('src'));
          if(t && h && !map[h]) map[h] = t;
        });
      }
    }
  }catch(err){ console.warn('Table of contents not readable', err); }
  return map;
}

function htmlToText(html){
  // A DOMParser document inherits this page's Content-Security-Policy, so every
  // style="" in the EPUB is reported as a violation even though nothing is
  // rendered. Only the text is wanted, so the attributes go before parsing.
  html = String(html).replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,head').forEach(n=>n.remove());
  const out = [];
  const BLOCKS = 'h1,h2,h3,h4,p,li,blockquote,div';
  doc.body && doc.body.querySelectorAll(BLOCKS).forEach(n=>{
    // Skip wrappers: their own textContent would repeat the blocks inside them.
    if(n.querySelector(BLOCKS)) return;
    const t = n.textContent.replace(/\s+/g,' ').trim();
    if(t) out.push(/^h[1-4]$/i.test(n.tagName) ? '## '+t : t);
  });
  // fallback if structure had no block elements
  if(!out.length && doc.body){
    const t = doc.body.textContent.replace(/\s+/g,' ').trim();
    if(t) out.push(t);
  }
  return out.join('\n\n');
}

// About three phone screens of reading. Anything much longer turns a section
// into an endless scroll with no way to keep your place.
const SECTION_LIMIT = 3500;

// Cuts a run of text at the limit without breaking a word.
function hardWrap(s){
  if(s.length <= SECTION_LIMIT) return [s];
  const out = [];
  let rest = s;
  while(rest.length > SECTION_LIMIT){
    let cut = rest.lastIndexOf(' ', SECTION_LIMIT);
    if(cut < SECTION_LIMIT / 2) cut = SECTION_LIMIT;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if(rest) out.push(rest);
  return out;
}

// A single paragraph can be longer than a whole section -- a letter quoted in
// full, for instance. Sections used to be capped only between paragraphs, so
// one of those left a wall of text a dozen screens long. It is cut at sentence
// ends, and only failing that between words.
function splitParagraph(para){
  if(para.length <= SECTION_LIMIT) return [para];
  const out = [];
  let buf = '';
  const push = ()=>{ if(buf.trim()) out.push(buf.trim()); buf = ''; };
  const sentences = para.match(/[^.!?]+(?:[.!?]+["'”’)\]]*\s*|$)/g) || [para];
  for(const sentence of sentences){
    for(const piece of hardWrap(sentence)){
      if(buf && (buf + piece).length > SECTION_LIMIT) push();
      buf += piece;
    }
  }
  push();
  return out.length ? out : [para];
}

// Split pasted/txt text into reasonable "chapters/pages"
function splitChapters(text){
  text = text.replace(/\r\n/g,'\n').trim();
  const paras = text.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean);
  const chapters = [];
  let buf = [], len = 0;
  const flush = ()=>{ if(buf.length){ chapters.push(buf.join('\n\n')); buf = []; len = 0; } };
  for(const para of paras){
    for(const piece of splitParagraph(para)){
      // cut before going over, so the limit is a ceiling and not a floor:
      // cutting after meant a section could reach twice the intended length
      if(len && len + piece.length > SECTION_LIMIT) flush();
      buf.push(piece); len += piece.length;
    }
  }
  flush();
  // a scrap left at the end reads better attached to what came before it
  if(chapters.length > 1 && chapters[chapters.length-1].length < SECTION_LIMIT / 6){
    const tail = chapters.pop();
    chapters[chapters.length-1] += '\n\n' + tail;
  }
  return chapters.length ? chapters : [text];
}

/* ============ READER ============ */
function openBook(id){
  current = booksCache.find(b=>b.id===id);
  if(!current) return;
  document.getElementById('library').style.display='none';
  document.getElementById('reader').style.display='block';
  document.getElementById('readerControls').classList.remove('hidden');
  document.getElementById('readerTitle').textContent = current.title;
  renderChapterNav();
  renderChapter();
  restoreScroll();
}

// Sections run to ~3500 characters, so returning to the top of one loses the
// reader's place. The position is kept as a fraction of the scrollable height,
// which survives a change of font size or window width.
function restoreScroll(){
  const frac = (current && current.scroll) || 0;
  requestAnimationFrame(()=>{
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, max > 0 ? Math.round(frac * max) : 0);
  });
}
let scrollSaveT;
window.addEventListener('scroll', ()=>{
  if(!current || document.getElementById('reader').style.display !== 'block') return;
  clearTimeout(scrollSaveT);
  scrollSaveT = setTimeout(()=>{
    if(!current) return;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    current.scroll = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    persistPos();
  }, 400);
}, { passive:true });
function goLibrary(){
  hidePopup();
  if(typeof hideSelButton==='function') hideSelButton();
  current = null;
  document.getElementById('reader').style.display='none';
  document.getElementById('readerControls').classList.add('hidden');
  document.getElementById('library').style.display='block';
  renderLibrary();
}
function renderChapter(){
  if(typeof hideSelButton==='function') hideSelButton();
  const pos = current.pos||0;
  const text = current.chapters[pos]||'';
  const container = document.getElementById('readerText');
  const marks = wordMarks();
  const paras = text.split(/\n\s*\n/);
  container.innerHTML = paras.map(p=>{
    if(p.startsWith('## ')) return '<h2>'+wrapWords(p.slice(3), marks)+'</h2>';
    return '<p>'+wrapWords(p, marks)+'</p>';
  }).join('');
  CHAP_SELECTS.forEach(id=>{ document.getElementById(id).value = String(pos); });
  document.getElementById('prevBtn').disabled = pos===0;
  document.getElementById('nextBtn').disabled = pos===current.chapters.length-1;
}
const CHAP_SELECTS = ['chapSel', 'chapSel2'];

function chapterLabel(i){
  const t = (current.titles||[])[i];
  return t ? (i+1)+'. '+t : 'Sección '+(i+1)+' de '+current.chapters.length;
}

// "CHAPTER IV. · 2/3" -> "CHAPTER IV." so the parts of one chapter can be
// gathered under a single heading in the picker.
function chapterGroup(i){
  const t = (current.titles||[])[i] || '';
  const cut = t.lastIndexOf(' · ');
  return cut > 0 ? t.slice(0, cut) : '';
}

// A novel can run to a couple of hundred sections. Grouping the parts of each
// chapter turns a flat wall of options into something you can actually scan.
function renderChapterNav(){
  let html = '';
  for(let i = 0; i < current.chapters.length; i++){
    const group = chapterGroup(i);
    if(!group){
      html += `<option value="${i}">${esc(chapterLabel(i))}</option>`;
      continue;
    }
    let end = i;
    while(end + 1 < current.chapters.length && chapterGroup(end + 1) === group) end++;
    if(end === i){
      html += `<option value="${i}">${esc(chapterLabel(i))}</option>`;
    }else{
      html += `<optgroup label="${esc(group)}">`;
      for(let j = i; j <= end; j++){
        const part = ((current.titles||[])[j] || '').slice(group.length + 3) || String(j+1);
        html += `<option value="${j}">${esc((j+1)+'. '+part)}</option>`;
      }
      html += `</optgroup>`;
      i = end;
    }
  }
  CHAP_SELECTS.forEach(id=>{
    const sel = document.getElementById(id);
    sel.innerHTML = html;
    sel.value = String(current.pos||0);
  });
}
CHAP_SELECTS.forEach(id=>{
  document.getElementById(id).addEventListener('change', e=>{
    if(!current) return;
    goToChapter(Number(e.target.value) || 0);
  });
});

// Which saved words to mark up in the text, and which of them are waiting to
// be reviewed today. A word that comes back in a real sentence on the very day
// it is due is worth more than the same word on a card, and it costs nothing.
function wordMarks(){
  const saved = new Map();   // lowercase form -> is it due today
  const add = (form, due)=>{
    if(!form) return;
    saved.set(form, (saved.get(form) || false) || due);
  };
  DB.vocab.forEach(v=>{
    const due = isDue(v);
    add(v.term.toLowerCase(), due);
    add((v.lemma || '').toLowerCase(), due);
  });
  return saved;
}
// A word saved as `run` is the same word as `running` in the text: the reader
// does not want to be told they have not saved it yet.
function markFor(low, marks){
  if(marks.has(low)) return marks.get(low) ? 'w saved due' : 'w saved';
  for(const form of baseForms(low)){
    if(marks.has(form)) return marks.get(form) ? 'w saved due' : 'w saved';
  }
  return 'w';
}
// wrap each word-token in a clickable span, keep punctuation
function wrapWords(str, marks){
  return str.replace(/\p{L}+(?:['’-]\p{L}+)*|[^\p{L}]+/gu, tok=>{
    if(/^\p{L}/u.test(tok)){
      const low = tok.toLowerCase();
      let cls = markFor(low, marks);
      if(searchTerm && low.includes(searchTerm)) cls += ' hit';
      return `<span class="${cls}">${esc(tok)}</span>`;
    }
    return esc(tok);
  });
}
function goToChapter(pos){
  if(!current || pos < 0 || pos > current.chapters.length-1) return;
  current.pos = pos;
  current.scroll = 0;          // a new section always starts at the top
  persistPos(); renderChapter(); window.scrollTo(0,0);
}
function prevChapter(){ goToChapter((current.pos||0) - 1); }
function nextChapter(){ goToChapter((current.pos||0) + 1); }
function persistPos(){
  const b = booksCache.find(x=>x.id===current.id);
  if(b){ b.pos = current.pos; persistBook(b); }
}

/* ============ SEARCH INSIDE A BOOK ============ */
let searchTerm = '';          // highlighted in the text while it is set

function openSearch(){
  openModal('searchModal');
  const input = document.getElementById('searchInput');
  input.value = searchTerm;
  runSearch();
}

function snippetAround(text, at, term){
  const from = Math.max(0, at - 60);
  const before = (from ? '…' : '') + text.slice(from, at);
  const after = text.slice(at + term.length, at + term.length + 60) +
                (at + term.length + 60 < text.length ? '…' : '');
  return esc(before) + '<mark>' + esc(text.slice(at, at + term.length)) + '</mark>' + esc(after);
}

function runSearch(){
  const term = document.getElementById('searchInput').value.trim();
  const list = document.getElementById('searchResults');
  const count = document.getElementById('searchCount');
  searchTerm = term.toLowerCase();
  if(!current || term.length < 2){
    list.innerHTML = '';
    count.textContent = term ? 'Escribe al menos dos letras.' : '';
    return;
  }
  const needle = term.toLowerCase();
  const hits = [];
  for(let i = 0; i < current.chapters.length && hits.length < 60; i++){
    const text = current.chapters[i];
    const hay = text.toLowerCase();
    let at = hay.indexOf(needle);
    while(at !== -1 && hits.length < 60){
      hits.push({ i, html: snippetAround(text, at, term) });
      at = hay.indexOf(needle, at + needle.length);
    }
  }
  count.textContent = hits.length
    ? hits.length + (hits.length === 1 ? ' resultado' : ' resultados') + (hits.length === 60 ? ' (se muestran los primeros)' : '')
    : 'Sin resultados.';
  list.innerHTML = hits.map(h=>
    `<button class="searchhit" data-go="${h.i}">
       <span class="where">${esc(chapterLabel(h.i))}</span>
       <span class="snippet">${h.html}</span>
     </button>`).join('');
}

document.getElementById('searchResults').addEventListener('click', e=>{
  const hit = e.target.closest('[data-go]');
  if(!hit) return;
  closeModal('searchModal');
  goToChapter(Number(hit.dataset.go));
  requestAnimationFrame(()=>{
    const first = document.querySelector('#readerText .w.hit');
    if(first) first.scrollIntoView({ block:'center' });
  });
});
let searchT;
let emailT;
document.getElementById('prefEmail').addEventListener('input', e=>{
  clearTimeout(emailT);
  const value = e.target.value;
  emailT = setTimeout(()=>saveTranslatorEmail(value), 400);
});

document.getElementById('searchInput').addEventListener('input', ()=>{
  clearTimeout(searchT);
  searchT = setTimeout(runSearch, 180);
});

/* ============ LOOKUP (word & phrase) ============ */
const pop = document.getElementById('pop');

// The popup never interpolates text into JS: its buttons read the current
// lookup from popState, so quotes in a book or in an API reply are harmless.
let popState = { term:'', trans:'', audio:'' };
let lookupSeq = 0; // discards replies from a lookup the reader already left

pop.addEventListener('click', e=>{
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  if(btn.dataset.act === 'speak'){
    report('speak', { word: reportContent(popState.term) });
    pronounce(popState.audio, popState.term);
  }
  else if(btn.dataset.act === 'save') saveVocab(popState.term, popState.trans, popState);
  else if(btn.dataset.act === 'settings'){ hidePopup(); openReading(); }
});

// Keyed by term, not by index: the list can be searched, filtered and sorted,
// so a row's position says nothing about where the word is stored.
document.getElementById('vocabList').addEventListener('click', e=>{
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  const term = btn.dataset.term;
  if(btn.dataset.act === 'speak'){
    const v = DB.vocab[findVocab(term)];
    if(v){ report('speak', { word: reportContent(v.term) }); pronounce(v.audio, v.term); }
  } else if(btn.dataset.act === 'del') delVocab(term);
  else if(btn.dataset.act === 'wake') wakeVocab(term);
});

document.getElementById('readerText').addEventListener('click', e=>{
  // if user selected a phrase, handle that on mouseup instead
  const sel = window.getSelection();
  if(sel && sel.toString().trim().split(/\s+/).length>1) return;
  const w = e.target.closest('.w');
  if(!w) return;
  e.stopPropagation();
  const word = w.textContent.replace(/^[^\p{L}]+|[^\p{L}]+$/gu,'');
  showPopupNear(w);
  lookupWord(word, sourceOf(w));
});

// phrase selection — works on desktop (mouse) and mobile (touch).
// When a multi-word selection exists inside the reader, show a floating
// "Traducir frase" button; tapping it translates the selected text.
const selBtn = document.getElementById('selBtn');
let selText = '';
let selSource = null;
let selUpdateT;

function isInReader(node){
  const el = node && (node.nodeType===1 ? node : node.parentElement);
  return el && el.closest('#readerText');
}

function updateSelButton(){
  const sel = window.getSelection();
  if(!sel || sel.rangeCount===0 || sel.isCollapsed){ hideSelButton(); return; }
  const txt = sel.toString().trim();
  // only for multi-word selections inside the reading area
  if(!txt || txt.split(/\s+/).length<2 || txt.length>300 ||
     !isInReader(sel.anchorNode) || !isInReader(sel.focusNode)){
    hideSelButton(); return;
  }
  selText = txt;
  selSource = sourceOfRange(sel.getRangeAt(0));
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  selBtn.style.display='block';
  const bw = selBtn.offsetWidth || 150;
  let x = rect.left + window.scrollX + rect.width/2 - bw/2;
  x = Math.max(8+window.scrollX, Math.min(x, window.scrollX+document.documentElement.clientWidth-bw-8));
  // place above the selection; if no room, place below
  let y = rect.top + window.scrollY - selBtn.offsetHeight - 8;
  if(rect.top < 50) y = rect.bottom + window.scrollY + 8;
  selBtn.style.left = x+'px';
  selBtn.style.top = y+'px';
}
function hideSelButton(){ selBtn.style.display='none'; selText=''; selSource=null; }

document.addEventListener('selectionchange', ()=>{
  clearTimeout(selUpdateT);
  selUpdateT = setTimeout(updateSelButton, 120);
});

// use pointerdown so it fires before the selection is cleared by the tap
selBtn.addEventListener('pointerdown', e=>{
  e.preventDefault(); e.stopPropagation();
  const txt = selText, source = selSource;
  if(!txt) return;
  const r = selBtn.getBoundingClientRect();
  hideSelButton();
  showPopupAt(r.left+window.scrollX, r.bottom+window.scrollY+6);
  lookupPhrase(txt, source);
});

document.addEventListener('click', e=>{
  if(e.target===selBtn) return;
  if(!pop.contains(e.target) && !e.target.closest('.w')) hidePopup();
});

function showPopupNear(el){
  const r = el.getBoundingClientRect();
  showPopupAt(r.left+window.scrollX, r.bottom+window.scrollY+6);
}
function showPopupAt(x, y){
  pop.style.display='block';
  pop.style.left = Math.min(x, window.scrollX+document.documentElement.clientWidth-360)+'px';
  pop.style.top = y+'px';
}
function hidePopup(){ pop.style.display='none'; }

// Browsers load the voice list asynchronously, so the very first tap used to
// be silent. Wait for the voices once, then pick an English one explicitly.
function englishVoice(){
  const vs = speechSynthesis.getVoices() || [];
  return vs.find(v=>/^en[-_]us/i.test(v.lang)) || vs.find(v=>/^en/i.test(v.lang)) || null;
}
function speak(text){
  if(!text) return;
  try{
    let spoken = false;
    const say = ()=>{
      if(spoken) return;
      spoken = true;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      // Picking a voice is a nicety: never let it stop the word being said.
      try{
        const v = englishVoice();
        if(v) u.voice = v;
      }catch(err){ console.warn('Could not select a voice', err); }
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    };
    if((speechSynthesis.getVoices()||[]).length) say();
    else{
      speechSynthesis.addEventListener('voiceschanged', say, { once:true });
      setTimeout(say, 300);   // some browsers never fire the event
    }
  }catch(err){ console.warn('Speech synthesis unavailable', err); }
}

// The dictionary ships recordings by real speakers; the synthesizer is the
// fallback when a word has none or the file will not play.
let currentAudio = null;
function pronounce(url, fallbackText){
  if(!url) return speak(fallbackText);
  try{
    if(currentAudio){ currentAudio.pause(); currentAudio = null; }
    speechSynthesis.cancel();
    const audio = new Audio(url);
    currentAudio = audio;
    audio.addEventListener('error', ()=>speak(fallbackText), { once:true });
    audio.play().catch(()=>speak(fallbackText));
  }catch(err){ speak(fallbackText); }
}

// Builds the popup from whatever has arrived so far.
function wordPopupHtml(s){
  const entry = s.entry;
  let html = `<div class="head"><span class="term" lang="en">${esc(s.word)}</span>`;
  if(entry && entry.phonetic) html += `<span class="phon">${esc(entry.phonetic)}</span>`;
  // say which base form answered, so "running -> run" is not a surprise
  if(entry && entry.matched) html += `<span class="phon">≈ ${esc(entry.matched)}</span>`;
  const speakTitle = (entry && entry.audio) ? 'Escuchar la pronunciación' : 'Pronunciar';
  html += `<button class="spk" data-act="speak" title="${speakTitle}">🔊</button></div>`;

  if(s.trans) html += `<div class="trans">🇪🇸 ${esc(s.trans)}</div>`;
  else if(s.transPending) html += `<div class="loading">Traduciendo…</div>`;

  if(entry && entry.meanings.length){
    entry.meanings.slice(0,3).forEach(m=>{
      html += `<div class="pos">${esc(m.pos)}</div>`;
      m.defs.slice(0,2).forEach(d=>{
        html += `<div class="defn">• ${esc(d.def)}</div>`;
        if(d.ex) html += `<div class="ex">“${esc(d.ex)}”</div>`;
      });
    });
  } else if(s.dictPending){
    html += `<div class="loading">Buscando definición…</div>`;
  } else if(!s.trans && !s.transPending){
    // nothing at all came back: say why
    const failure = s.transError || s.dictError;
    html += `<div class="err">${esc(errorMessage(failure))}</div>`;
    // the quota is the one failure the reader can actually do something about
    if(failure && failure.code === 'quota'){
      html += `<div class="row"><button data-act="settings">⚙️ Ampliar el límite</button></div>`;
    }
  }

  html += `<div class="row">
    <button class="primary" data-act="save">⭐ Guardar</button>
  </div>`;
  return html;
}

// The translation and the definition are painted as each arrives, so a slow or
// dead dictionary no longer holds back the word the reader actually wants.
// The phonetics, the base form, the first definition and the sentence the word
// was met in are all on screen already. Keeping them costs nothing and is what
// lets the word be practised later instead of merely recognised.
function firstDefOf(entry){
  const m = entry && entry.meanings && entry.meanings[0];
  const d = m && m.defs && m.defs[0];
  const text = (d && d.def) || '';
  return text.length > 200 ? text.slice(0, 197)+'…' : text;
}

function lookupWord(word, source){
  if(!word){ hidePopup(); return Promise.resolve(); }
  const turn = ++lookupSeq;
  const src = source || blankSource();
  popState = { term: word, trans: '', audio: '', kind: 'word',
               lemma: '', phon: '', def: '',
               ctx: src.ctx, book: src.book, chapter: src.chapter };
  const state = { word, entry: null, trans: null, dictPending: true, transPending: true,
                  dictError: null, transError: null };
  const paint = ()=>{ if(turn === lookupSeq) pop.innerHTML = wordPopupHtml(state); };
  paint();

  const translating = lookupTranslation(word).then(
    t => { state.trans = t; popState.trans = t || ''; },
    e => { state.transError = e; }
  ).then(()=>{ state.transPending = false; paint(); });

  const defining = lookupDict(word).then(
    d => {
      state.entry = d;
      popState.audio = (d && d.audio) || '';
      popState.lemma = (d && d.matched) || '';
      popState.phon = (d && d.phonetic) || '';
      popState.def = firstDefOf(d);
    },
    e => { state.dictError = e; }
  ).then(()=>{ state.dictPending = false; paint(); });

  return Promise.all([translating, defining]);
}

async function lookupPhrase(phrase, source){
  const turn = ++lookupSeq;
  const src = source || blankSource();
  popState = { term: phrase, trans: '', audio: '', kind: 'phrase',
               lemma: '', phon: '', def: '',
               ctx: '', book: src.book, chapter: src.chapter };
  const head = `<div class="head"><span class="term">Frase</span>
    <button class="spk" data-act="speak" title="Pronunciar">🔊</button></div>
    <div class="ex">“${esc(phrase)}”</div>`;
  pop.innerHTML = head + `<div class="loading">Traduciendo…</div>`;
  let tr = null, failure = null;
  try{ tr = await lookupTranslation(phrase); }catch(err){ failure = err; }
  if(turn !== lookupSeq) return;
  popState.trans = tr || '';
  let html = head;
  if(tr) html += `<div class="trans">🇪🇸 ${esc(tr)}</div>`;
  else html += `<div class="err">${esc(failure ? errorMessage(failure) : 'No se pudo traducir la frase.')}</div>`;
  html += `<div class="row"><button class="primary" data-act="save">⭐ Guardar</button></div>`;
  pop.innerHTML = html;
}

/* ---- LOOKUP CACHE ---- */
// A definition does not change, so a word looked up once is answered from
// disk: instant, no quota spent, and it keeps working with no connection.
function cacheGet(key){
  if(!idb) return Promise.resolve(null);
  return idbTx(IDB_LOOKUPS, 'readonly', s=>s.get(key)).catch(()=>null);
}
function cachePut(key, data){
  if(!idb) return;
  idbTx(IDB_LOOKUPS, 'readwrite', s=>s.put({ key, data, ts: Date.now() }))
    .catch(err=>console.warn('Lookup cache write failed', err));
}
// Only real answers are stored. An empty one may just mean an exhausted
// quota or an outage, and caching that would poison the word for good.
async function cached(key, fetcher){
  const hit = await cacheGet(key);
  if(hit && hit.data) return hit.data;
  const data = await fetcher();
  if(data) cachePut(key, data);
  return data;
}
// A word the dictionary genuinely does not know is worth remembering too, so
// it is not looked up again on every tap. Transient failures throw instead.
// While the dictionary is unreachable, one lookup pays the timeout and the
// rest fail instantly: the translation is what the reader is waiting for.
const DICT_COOLDOWN = 5 * 60 * 1000;
let dictDownUntil = 0;

const isTransient = err => !!err && ['network','timeout','service'].includes(err.code);

async function lookupDict(word){
  const key = 'd:'+word.toLowerCase().trim();
  const hit = await cacheGet(key);
  if(hit) return hit.data;              // data may be null: a known non-word
  const data = await fetchDict(word);
  cachePut(key, data);
  return data;
}
function lookupTranslation(text){ return cached('t:'+text.trim(), ()=>translate(text)); }

/* ---- APIs (free, no key) ---- */
// A fallback for anyone self-hosting their own copy. On the public site it
// stays empty -- the address would be visible to everyone -- and each reader
// sets their own in Settings, which is stored on their device alone.
const MYMEMORY_EMAIL = '';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function translatorEmail(){
  const own = (DB.prefs.mmEmail || '').trim();
  if(own && EMAIL_RE.test(own)) return own;
  return MYMEMORY_EMAIL;
}

function saveTranslatorEmail(raw){
  const value = String(raw || '').trim();
  const field = document.getElementById('prefEmail');
  const ok = !value || EMAIL_RE.test(value);
  field.setAttribute('aria-invalid', ok ? 'false' : 'true');
  document.getElementById('emailHint').classList.toggle('err', !ok);
  if(!ok) return;
  const p = DB.prefs;
  if(value) p.mmEmail = value; else delete p.mmEmail;
  DB.prefs = p;
}

// No third party gets to hold the reader hostage: a request that has not
// answered by now is abandoned. dictionaryapi.dev has been seen taking 20s to
// fail, which froze the popup for every single word.
const API_TIMEOUT = 6000;

async function apiFetch(url){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), API_TIMEOUT);
  try{
    return await fetch(url, { signal: ctrl.signal });
  }catch(err){
    throw apiError(err && err.name === 'AbortError' ? 'timeout' : 'network', 'No hubo respuesta');
  }finally{
    clearTimeout(timer);
  }
}

function apiError(code, message){
  const err = new Error(message);
  err.code = code;
  return err;
}
function errorMessage(err){
  if(err && err.code === 'quota') return 'Cuota diaria de traducción agotada. Inténtalo mañana.';
  if(err && err.code === 'timeout') return 'El servicio tarda demasiado en responder.';
  if(err && err.code === 'network') return 'Sin conexión. Solo funcionan las palabras ya consultadas.';
  if(err && err.code === 'service') return 'El servicio no responde ahora mismo.';
  return 'No se encontró información para esta palabra.';
}

// The dictionary only holds base forms. These are the regular ways an English
// word gets inflected, plus the irregulars a reader actually trips over.
const IRREGULARS = {
  was:'be', were:'be', been:'be', had:'have', did:'do', done:'do',
  went:'go', gone:'go', said:'say', got:'get', gotten:'get', made:'make',
  knew:'know', known:'know', thought:'think', took:'take', taken:'take',
  saw:'see', seen:'see', came:'come', found:'find', gave:'give', given:'give',
  told:'tell', became:'become', left:'leave', felt:'feel', brought:'bring',
  began:'begin', begun:'begin', kept:'keep', held:'hold', wrote:'write',
  written:'write', stood:'stand', heard:'hear', meant:'mean', met:'meet',
  ran:'run', paid:'pay', sat:'sit', spoke:'speak', spoken:'speak',
  led:'lead', grew:'grow', grown:'grow', lost:'lose', fell:'fall',
  fallen:'fall', sent:'send', built:'build', understood:'understand',
  drew:'draw', broke:'break', broken:'break', spent:'spend', rose:'rise',
  risen:'rise', drove:'drive', driven:'drive', bought:'buy', wore:'wear',
  worn:'wear', chose:'choose', chosen:'choose', ate:'eat', eaten:'eat',
  threw:'throw', thrown:'throw', caught:'catch', taught:'teach', sold:'sell',
  fought:'fight', slept:'sleep', woke:'wake', woken:'wake', drank:'drink',
  swam:'swim', sang:'sing', sung:'sing', rang:'ring', rung:'ring',
  hung:'hang', shook:'shake', shaken:'shake', stole:'steal', stolen:'steal',
  better:'good', best:'good', worse:'bad', worst:'bad',
  men:'man', women:'woman', children:'child', feet:'foot', teeth:'tooth',
  mice:'mouse', geese:'goose', people:'person'
};

function baseForms(word){
  const w = word.toLowerCase();
  const out = [];
  const add = f=>{ if(f && f.length > 1 && f !== w && !out.includes(f)) out.push(f); };
  add(IRREGULARS[w]);
  // doubled consonant: stopped -> stop, running -> run
  const dbl = w.match(/^(.*?)([bdfglmnprt])\2(ed|ing|er|est)$/);
  if(dbl) add(dbl[1]+dbl[2]);
  if(/ies$/.test(w)) add(w.slice(0,-3)+'y');
  if(/(ses|xes|zes|ches|shes)$/.test(w)) add(w.slice(0,-2));
  if(/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0,-1));
  if(/ied$/.test(w)) add(w.slice(0,-3)+'y');
  if(/ed$/.test(w)){ add(w.slice(0,-2)); add(w.slice(0,-1)); }
  if(/ing$/.test(w)){ add(w.slice(0,-3)); add(w.slice(0,-3)+'e'); }
  if(/est$/.test(w)){ add(w.slice(0,-3)); add(w.slice(0,-2)); }
  if(/er$/.test(w)){ add(w.slice(0,-2)); add(w.slice(0,-1)); }
  return out.slice(0, 4);
}

// One request. null means the dictionary answered "no such word"; anything
// transient throws, so a passing outage is never cached as a miss.
// Wiktionary carries no phonetics or recordings, but it is far more reliable
// than the primary dictionary and it knows inflected forms as entries of their
// own. Its definitions arrive as HTML.
function stripTags(html){
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) =>
      ({ amp:'&', lt:'<', gt:'>', quot:'"', '#39':"'", nbsp:' ' }[e]))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchWiktionary(word){
  const r = await apiFetch('https://en.wiktionary.org/api/rest_v1/page/definition/'+encodeURIComponent(word.toLowerCase()));
  if(r.status === 404) return null;
  if(!r.ok) throw apiError('service', 'El diccionario no responde');
  let data;
  try{ data = await r.json(); }catch(err){ throw apiError('service', 'Respuesta ilegible'); }
  const english = data && data.en;
  if(!Array.isArray(english) || !english.length) return null;
  const meanings = english.slice(0,3).map(m=>({
    pos: (m.partOfSpeech || '').toLowerCase(),
    defs: (m.definitions || []).slice(0,2).map(d=>({
      def: stripTags(d.definition),
      ex: (d.parsedExamples && d.parsedExamples[0]) ? stripTags(d.parsedExamples[0].example) : ''
    })).filter(d=>d.def)
  })).filter(m=>m.defs.length);
  if(!meanings.length) return null;
  return { phonetic:'', audio:'', meanings, source:'wiktionary' };
}

async function fetchFreeDictionary(word){
  const r = await apiFetch('https://api.dictionaryapi.dev/api/v2/entries/en/'+encodeURIComponent(word.toLowerCase()));
  if(r.status === 404) return null;
  if(!r.ok) throw apiError('service', 'El diccionario no responde');
  let data;
  try{ data = await r.json(); }catch(err){ throw apiError('service', 'Respuesta ilegible'); }
  if(!Array.isArray(data) || !data[0]) return null;
  const entry = data[0];
  const phonetics = entry.phonetics || [];
  const phonetic = entry.phonetic || (phonetics.find(p=>p.text)||{}).text || '';
  const audioRaw = (phonetics.find(p=>p.audio)||{}).audio || '';
  const audio = audioRaw.startsWith('//') ? 'https:'+audioRaw : audioRaw;
  const meanings = (entry.meanings||[]).map(m=>({
    pos: m.partOfSpeech,
    defs: (m.definitions||[]).map(d=>({def:d.definition, ex:d.example}))
  }));
  return { phonetic, audio, meanings };
}

// The richer provider first; while it is failing, Wiktionary answers instead
// and the reader keeps getting definitions rather than an empty popup.
async function fetchDictEntry(word){
  if(Date.now() >= dictDownUntil){
    try{
      const hit = await fetchFreeDictionary(word);
      dictDownUntil = 0;
      return hit;                       // null here is a confirmed non-word
    }catch(err){
      if(!isTransient(err)) throw err;
      dictDownUntil = Date.now() + DICT_COOLDOWN;
      console.warn('Dictionary unavailable, falling back to Wiktionary', err);
    }
  }
  return fetchWiktionary(word);
}

async function fetchDict(word){
  const direct = await fetchDictEntry(word);
  if(direct) return direct;
  // The likeliest stems come first, and only those are asked: in parallel this
  // is one extra round trip instead of up to four, without hammering a free API.
  const forms = baseForms(word).slice(0, 2);
  if(!forms.length) return null;
  // A rejection propagates, so a passing failure is never cached as a miss.
  const tries = await Promise.all(forms.map(fetchDictEntry));
  for(let i = 0; i < tries.length; i++){
    if(tries[i]){ tries[i].matched = forms[i]; return tries[i]; }
  }
  return null;
}

async function translate(text){
  // MyMemory free translation API (en -> es)
  let url = 'https://api.mymemory.translated.net/get?q='+encodeURIComponent(text)+'&langpair=en|es';
  const email = translatorEmail();
  if(email) url += '&de='+encodeURIComponent(email);
  const r = await apiFetch(url);
  if(!r.ok) throw apiError(r.status === 429 ? 'quota' : 'service', 'El traductor no responde');
  let d;
  try{ d = await r.json(); }catch(err){ throw apiError('service', 'Respuesta ilegible'); }
  const t = (d.responseData && d.responseData.translatedText) || '';
  const notice = t + ' ' + (d.responseDetails || '');
  // A quota message must never be cached as if it were a translation.
  if(/MYMEMORY WARNING|QUERY LENGTH LIMIT|TOO MANY REQUESTS|DAILY LIMIT/i.test(notice)){
    throw apiError('quota', 'Cuota agotada');
  }
  return t || null;
}

/* ============ VOCAB ============ */
// The day the reader is living in, not the one in Greenwich: at half past
// midnight in Madrid a UTC "today" is still yesterday, and a card due today
// would quietly fail to show up.
function localISO(d){
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
}
function todayISO(){ return localISO(new Date()); }
function addDays(n){
  const d = new Date();
  d.setDate(d.getDate() + n);
  return localISO(d);
}

// A word failed this many times is not being learned, it is being ground
// through: it is set aside until the reader decides what to do with it.
const LEECH_LAPSES = 8;
// Scheduled three weeks out, a word no longer needs the app to stay in memory.
const MATURE_DAYS = 21;
// How many times a brand new word has to be answered right before it is
// scheduled by date at all. Meeting a word once and then not again for a whole
// day is exactly how it gets forgotten before its first real review.
const LEARN_STEPS = 2;

// Both limits are what keeps the habit alive: fifty words saved in one chapter
// becoming fifty cards tomorrow morning is how a reader quits. 0 = no limit.
function newPerDay(){
  const n = DB.prefs.newPerDay;
  return Number.isFinite(n) ? Math.max(0, n) : 10;
}
function sessionCap(){
  const n = DB.prefs.sessionCap;
  return Number.isFinite(n) ? Math.max(0, n) : 40;
}

// Items saved before phrases were told apart from words carry no kind.
function kindOf(v){ return v.kind || (/\s/.test(v.term) ? 'phrase' : 'word'); }
function isNew(v){ return !v.reviewed; }
function isDue(v){ return !v.leech && (!v.due || v.due <= todayISO()); }
function isMature(v){ return (v.interval || 0) >= MATURE_DAYS; }

// The cards the reader will actually be shown, in the order they will meet
// them: everything they have seen before first, then as many words they have
// never met as the daily allowance still has room for.
function dueQueue(list){
  const vocab = list || DB.vocab;
  const today = todayISO();
  const live = vocab.filter(v=>!v.leech);
  const seen = live.filter(v=>!isNew(v) && (!v.due || v.due <= today));
  const fresh = live.filter(v=>isNew(v) && (!v.due || v.due <= today));
  const allowance = newPerDay();
  const room = allowance ? Math.max(0, allowance - statFor(today).new) : fresh.length;
  const queue = seen.concat(fresh.slice(0, room));
  const cap = sessionCap();
  return cap ? queue.slice(0, cap) : queue;
}
function dueCount(){ return dueQueue().length; }

function dueLabel(v){
  if(v.leech) return 'en pausa';
  if(isDue(v)) return 'hoy';
  const days = Math.round((new Date(v.due) - new Date(todayISO())) / 86400000);
  return days === 1 ? 'mañana' : 'en '+days+' d';
}
function updateDueBadge(){
  const n = dueCount();
  const el = document.getElementById('dueBadge');
  el.textContent = n;
  el.classList.toggle('hidden', n === 0);
}

/* ---- STATS ---- */
// One row per day: cards graded, and words met for the first time. It is what
// the daily allowance is measured against, and what turns "I have 300 words"
// into "I have shown up eleven days running", which is the part that keeps
// anyone coming back.
function statFor(day){
  const row = (DB.stats.log || {})[day];
  return { rev: (row && row.rev) || 0, new: (row && row.new) || 0 };
}
function bumpStat(field){
  const s = DB.stats;
  const log = s.log || (s.log = {});
  const row = log[todayISO()] || (log[todayISO()] = { rev:0, new:0 });
  row[field] = (row[field] || 0) + 1;
  const days = Object.keys(log).sort();
  while(days.length > 400) delete log[days.shift()];   // a year of history is plenty
  DB.stats = s;
}
// Days in a row ending today. A day that has not been studied *yet* does not
// break a streak: only a day that went by without a single review does.
function streakDays(){
  const log = DB.stats.log || {};
  const d = new Date();
  if(!(log[localISO(d)] || {}).rev) d.setDate(d.getDate() - 1);
  let n = 0;
  while((log[localISO(d)] || {}).rev){ n++; d.setDate(d.getDate() - 1); }
  return n;
}

/* ---- SAVING ---- */
// Where a word was met. A word remembered with the sentence it came from can
// be practised in context later; the same word on its own can only ever be a
// flashcard, and a flashcard is not what transfers to reading.
function blankSource(){
  return { ctx:'', book: current ? current.id : '', chapter: current ? (current.pos||0) : null };
}
function sourceOfRange(range){
  const out = blankSource();
  const node = range.startContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const para = el && el.closest && el.closest('p, h2');
  if(!para) return out;
  const upTo = range.cloneRange();
  upTo.selectNodeContents(para);
  try{ upTo.setEnd(range.startContainer, range.startOffset); }catch(err){ return out; }
  out.ctx = sentenceAt(para.textContent, upTo.toString().length);
  return out;
}
function sourceOf(el){
  const r = document.createRange();
  r.selectNode(el);
  return sourceOfRange(r);
}
// The sentence holding the character at `at`. One so long that quoting it
// would fill the card is dropped: no context beats useless context.
function sentenceAt(text, at){
  const parts = text.match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) || [text];
  let acc = 0;
  for(const part of parts){
    if(at < acc + part.length){
      const one = part.trim().replace(/\s+/g, ' ');
      return (one.length > 300 || one.length < 3) ? '' : one;
    }
    acc += part.length;
  }
  return '';
}

// Everything the popup already had on screen is kept: throwing away the
// phonetics, the definition and the sentence only to store a bare pair of
// words is what makes a vocabulary list useless a month later.
function saveVocab(term, trans, info){
  term = term.trim();
  if(!term) return;
  const extra = info || {};
  const vocab = DB.vocab;
  const lemma = (extra.lemma || '').toLowerCase();
  const key = lemma || term.toLowerCase();
  // went / gone / going are one word to learn, not three cards to fail
  const twin = vocab.find(v=>v.term.toLowerCase() === term.toLowerCase() ||
                             (v.lemma || v.term).toLowerCase() === key);
  if(twin){
    toast(twin.term.toLowerCase() === term.toLowerCase()
      ? 'Ya estaba en tu vocabulario'
      : 'Ya la tienes como «'+twin.term+'»');
    hidePopup();
    return;
  }
  vocab.unshift({
    term,
    trans: trans || '',
    kind: extra.kind || (/\s/.test(term) ? 'phrase' : 'word'),
    lemma: lemma && lemma !== term.toLowerCase() ? lemma : '',
    phon: extra.phon || '',
    audio: extra.audio || '',
    def: extra.def || '',
    ctx: extra.ctx || '',
    book: extra.book || '',
    chapter: Number.isInteger(extra.chapter) ? extra.chapter : null,
    date: todayISO(), due: todayISO(),
    interval: 0, ease: 2.5, reps: 0, step: 0, lapses: 0
  });
  DB.vocab = vocab;
  toast('⭐ Guardado: '+term + (lemma && lemma !== term.toLowerCase() ? ' · base: '+lemma : ''));
  hidePopup();
  updateDueBadge();
  if(current) renderChapter();
}

/* ---- THE LIST ---- */
const VOCAB_FILTERS = {
  all:      ()=>true,
  due:      isDue,
  new:      isNew,
  learning: v=>!isNew(v) && !v.leech && !isMature(v),
  known:    isMature,
  hard:     v=>!!v.leech || (v.lapses || 0) >= 3,
  phrase:   v=>kindOf(v) === 'phrase'
};
// `added` keeps the stored order, which is newest first; Array#sort is stable.
const VOCAB_SORTS = {
  added: ()=>0,
  alpha: (a,b)=>a.term.localeCompare(b.term, 'en'),
  due:   (a,b)=>String(a.due||'').localeCompare(String(b.due||'')),
  hard:  (a,b)=>(b.lapses||0) - (a.lapses||0)
};

function openVocab(){
  renderVocab();
  openModal('vocabModal');
}
function findVocab(term){
  return DB.vocab.findIndex(v=>v.term === term);
}
function vocabTools(){
  return {
    q: normalizeAnswer(document.getElementById('vocabSearch').value),
    filter: VOCAB_FILTERS[document.getElementById('vocabFilter').value] || VOCAB_FILTERS.all,
    sort: VOCAB_SORTS[document.getElementById('vocabSort').value] || VOCAB_SORTS.added
  };
}
// Three hundred words in one flat list is a wall nobody reads. What a reader
// wants to find is the handful that are giving them trouble.
function renderVocab(){
  const vocab = DB.vocab;
  const { q, filter, sort } = vocabTools();
  const shown = vocab
    .filter(v=>filter(v) &&
      (!q || normalizeAnswer(v.term+' '+(v.trans||'')+' '+(v.lemma||'')).includes(q)))
    .sort(sort);

  document.getElementById('vocabStats').innerHTML = vocabStatsHtml(vocab);
  const due = dueCount();
  document.getElementById('revCount').textContent = due ? ' ('+due+')' : '';
  document.getElementById('vocabEmpty').classList.toggle('hidden', vocab.length > 0);
  const none = document.getElementById('vocabNone');
  none.classList.toggle('hidden', !vocab.length || shown.length > 0);

  document.getElementById('vocabList').innerHTML = shown.map(v=>`
    <div class="vocab-item" data-state="${vocabState(v)}">
      <span class="vt" lang="en">${esc(v.term)}${v.lemma ? `<i class="vlem">≈ ${esc(v.lemma)}</i>` : ''}</span>
      <span class="vd">${esc(v.trans||'—')}${v.ctx ? `<i class="vctx">“${esc(v.ctx)}”</i>` : ''}</span>
      <span class="vwhen" title="Próximo repaso">${esc(dueLabel(v))}${
        (v.lapses || 0) >= 3 ? `<i class="vfails">${v.lapses} fallos</i>` : ''}</span>
      <button class="spk" data-act="speak" data-term="${esc(v.term)}" title="Pronunciar">🔊</button>
      ${v.leech ? `<button class="vwake" data-act="wake" data-term="${esc(v.term)}" title="En pausa: reactivar">🐌</button>` : ''}
      <button class="vdel" data-act="del" data-term="${esc(v.term)}" title="Eliminar">✕</button>
    </div>`).join('');
  updateDueBadge();
}
function vocabState(v){
  if(v.leech) return 'hard';
  if(isNew(v)) return 'new';
  return isMature(v) ? 'known' : 'learning';
}
// Numbers only, so the interpolation into markup is safe.
function vocabStatsHtml(vocab){
  const today = statFor(todayISO());
  const streak = streakDays();
  const known = vocab.filter(isMature).length;
  const bits = [
    streak ? '🔥 <b>'+streak+'</b> '+(streak === 1 ? 'día seguido' : 'días seguidos')
           : '🔥 Empieza hoy tu racha',
    '⭐ <b>'+vocab.length+'</b> guardadas',
    '🎯 <b>'+dueCount()+'</b> para hoy',
    '✅ <b>'+known+'</b> aprendidas'
  ];
  if(today.rev) bits.push('📅 <b>'+today.rev+'</b> repasadas hoy');
  return bits.map(b=>'<span>'+b+'</span>').join('');
}

function delVocab(term){
  const i = findVocab(term);
  if(i < 0) return;
  const vocab = DB.vocab;
  vocab.splice(i, 1); DB.vocab = vocab;
  renderVocab(); if(current) renderChapter();
}
// A suspended word is not a deleted one: the reader may well want it back once
// they have met it a few more times in a real book.
function wakeVocab(term){
  const i = findVocab(term);
  if(i < 0) return;
  const vocab = DB.vocab;
  vocab[i].leech = false;
  vocab[i].lapses = 0;
  vocab[i].due = todayISO();
  DB.vocab = vocab;
  toast('«'+vocab[i].term+'» vuelve al repaso');
  renderVocab();
}
function clearVocab(){
  if(!confirm('¿Vaciar todo el vocabulario?')) return;
  DB.vocab = []; renderVocab(); if(current) renderChapter();
}

/* ============ REVIEW (spaced repetition) ============ */
// Simplified SM-2 with an Anki-style learning phase. Cards are held by
// reference in revVocab, so grading one and writing the whole array back keeps
// the schedule in sync.
let revVocab = null, revQueue = [], revCard = null;
let revMode = 'flip', revPhase = 'ask', revVerdict = null, revChosen = '';

// Recognising a word is far easier than producing it, so these run from the
// easiest to the hardest and a card climbs as it matures.
const MODES = {
  mixed:  '🎲 Mixto',
  choice: '🔢 Test',
  flip:   '🔁 Tarjeta',
  type:   '⌨️ Escribir',
  cloze:  '␣ Hueco',
  listen: '👂 Dictado'
};
// The ones where the reader has to produce the English word themselves, and so
// the ones the app can grade instead of asking them to grade themselves.
const TYPED = ['type', 'cloze', 'listen'];
const ASKS = {
  flip:   '¿Qué significa?',
  choice: 'Elige la respuesta',
  type:   'Escríbela en inglés',
  cloze:  'Completa la frase del libro',
  listen: 'Escucha y escríbela'
};

function vocabPool(){ return revVocab || DB.vocab; }

// Only an exact appearance is blanked out: guessing where an inflected form
// sits in a sentence would hide the wrong thing often enough to be worse than
// not offering the exercise at all.
function clozeOf(card){
  if(!card.ctx || kindOf(card) === 'phrase') return null;
  const at = card.ctx.toLowerCase().indexOf(card.term.toLowerCase());
  if(at === -1) return null;
  return {
    before: card.ctx.slice(0, at),
    word:   card.ctx.slice(at, at + card.term.length),
    after:  card.ctx.slice(at + card.term.length)
  };
}

// A shuffle that depends only on the card, so getting a card wrong and meeting
// it again in the same session does not move the options around underneath.
function shuffleWith(list, seedText){
  let seed = 7;
  for(const ch of String(seedText)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const out = list.slice();
  for(let i = out.length - 1; i > 0; i--){
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function shuffle(list){
  const out = list.slice();
  for(let i = out.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The distractors come from the reader's own vocabulary: words they might
// plausibly confuse, rather than words they have never seen.
function choicesFor(card){
  const reverse = !!DB.prefs.revReverse;
  const answer = (reverse ? card.term : card.trans) || '';
  if(!answer) return [];
  const seen = new Set([normalizeAnswer(answer)]);
  const others = [];
  for(const v of vocabPool()){
    if(v.term === card.term || kindOf(v) === 'phrase') continue;
    const text = (reverse ? v.term : v.trans) || '';
    const key = normalizeAnswer(text);
    if(!key || seen.has(key)) continue;
    seen.add(key); others.push(text);
  }
  if(others.length < 3) return [];
  return shuffleWith(shuffleWith(others, card.term).slice(0, 3).concat(answer), card.term+'!');
}

function supportsMode(card, mode){
  if(kindOf(card) === 'phrase') return mode === 'flip';   // typing a whole phrase is cruel
  if(mode === 'cloze') return !!clozeOf(card);
  if(mode === 'choice') return choicesFor(card).length > 1;
  if(mode === 'listen') return 'speechSynthesis' in window;
  if(mode === 'type') return !!card.trans;                // nothing to prompt with otherwise
  return true;
}
// Fixed rather than random: a reader who knows what is coming answers the
// word, not the format.
function pickMode(card){
  const forced = DB.prefs.revMode || 'mixed';
  if(forced !== 'mixed') return supportsMode(card, forced) ? forced : 'flip';
  const reps = card.reps || 0;
  const wanted = reps === 0 ? ['choice', 'flip']
               : reps < 3   ? ['type', 'choice']
               : reps % 2   ? ['cloze', 'type']
                            : ['listen', 'cloze', 'type'];
  return wanted.find(m=>supportsMode(card, m)) || 'flip';
}

/* ---- ANSWER CHECKING ---- */
// Accents, case and punctuation are not what is being tested.
function normalizeAnswer(s){
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Optimal string alignment: Levenshtein, except that two letters typed in the
// wrong order count as the one slip they are. Transposing a pair is far and
// away the commonest typo, and counting it as two mistakes would fail a reader
// who knew the word perfectly well.
function editDistance(a, b){
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for(let j = 0; j <= n; j++) d[0][j] = j;
  for(let i = 1; i <= m; i++){
    for(let j = 1; j <= n; j++){
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1,
                         d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
      if(i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]){
        d[i][j] = Math.min(d[i][j], d[i-2][j-2] + 1);
      }
    }
  }
  return d[m][n];
}
// One slipped key is a typing mistake, not a word the reader does not know.
function nearMiss(answer, given){
  if(answer.length < 4 || Math.abs(answer.length - given.length) > 1) return false;
  return editDistance(answer, given) === 1;
}
// The production exercises always ask for the English word, whichever way the
// flashcards happen to be turned: producing Spanish is not the thing a Spanish
// speaker needs to practise.
function acceptedAnswers(card){
  return [card.term, card.lemma].map(normalizeAnswer).filter(Boolean);
}
function checkAnswer(text){
  const given = normalizeAnswer(text);
  if(!given) return 'blank';
  const answers = acceptedAnswers(revCard);
  if(answers.includes(given)) return 'right';
  if(answers.some(a=>nearMiss(a, given))) return 'close';
  return 'wrong';
}
// What the card is showing as the right answer once it is turned over.
function answerText(card){
  if(revMode === 'flip' || revMode === 'choice'){
    return DB.prefs.revReverse ? card.term : (card.trans || '—');
  }
  return card.term;
}
function answerLang(card){
  return (revMode === 'flip' || revMode === 'choice') && !DB.prefs.revReverse ? 'es' : 'en';
}

/* ---- SESSION ---- */
function openReview(){
  revVocab = DB.vocab;
  const queue = dueQueue(revVocab);
  if(!queue.length){
    toast(DB.vocab.some(isDue) ? 'Ya has hecho lo de hoy 🎉' : 'Nada que repasar hoy 🎉');
    return;
  }
  // what they have met before comes first: clearing the backlog matters more
  // than meeting yet another new word
  revQueue = shuffle(queue.filter(v=>!isNew(v))).concat(shuffle(queue.filter(isNew)));
  closeModal('vocabModal');
  paintReviewDirection();
  paintReviewMode();
  openModal('reviewModal');
  report('review_open');
  nextCard();
}

function reviewDirection(){
  const p = DB.prefs;
  p.revReverse = !p.revReverse;
  DB.prefs = p;
  paintReviewDirection();
  if(revCard){ revMode = pickMode(revCard); revPhase = 'ask'; revVerdict = null; renderReview(); }
}
function paintReviewDirection(){
  const btn = document.getElementById('revDirBtn');
  const reverse = !!DB.prefs.revReverse;
  btn.textContent = reverse ? '🇪🇸→🇬🇧' : '🇬🇧→🇪🇸';
  btn.setAttribute('aria-label', reverse
    ? 'Repaso de español a inglés. Pulsa para cambiar.'
    : 'Repaso de inglés a español. Pulsa para cambiar.');
}
function reviewMode(value){
  const p = DB.prefs;
  p.revMode = MODES[value] ? value : 'mixed';
  DB.prefs = p;
  paintReviewMode();
  if(revCard){ revMode = pickMode(revCard); revPhase = 'ask'; revVerdict = null; renderReview(); }
}
// The same choice is offered where it is decided (Settings) and where it is
// felt (mid-review), so both have to be kept saying the same thing.
function paintReviewMode(){
  const value = DB.prefs.revMode || 'mixed';
  document.getElementById('revModeSel').value = value;
  document.getElementById('prefExercise').value = value;
}

function nextCard(){
  revCard = revQueue.shift() || null;
  revPhase = 'ask';
  revVerdict = null;
  revChosen = '';
  revMode = revCard ? pickMode(revCard) : 'flip';
  renderReview();
  if(!revCard) return;
  if(revMode === 'listen') pronounce(revCard.audio, revCard.term);
  if(TYPED.includes(revMode)) document.getElementById('revInput').focus();
}

function renderReview(){
  const card = revCard, done = !card;
  const show = (id, on)=>document.getElementById(id).classList.toggle('hidden', !on);
  show('revDone', done);
  show('revCard', !done);
  document.getElementById('revProgress').textContent =
    done ? '' : (revQueue.length + 1) + ' por repasar';
  if(done){
    ['revShowRow','revGradeRow','revTypeRow','revChoiceRow','revVerdict'].forEach(id=>show(id, false));
    paintDone();
    return;
  }

  const reverse = !!DB.prefs.revReverse;
  const answering = revPhase === 'answer';
  const cloze = revMode === 'cloze' ? clozeOf(card) : null;

  document.getElementById('revKind').textContent = ASKS[revMode] ||
    (reverse ? '¿Cómo se dice en inglés?' : ASKS.flip);

  // the question
  const front = document.getElementById('revTerm');
  if(revMode === 'listen'){
    front.textContent = '🔊';
    front.lang = 'en';
  }else if(revMode === 'type' || revMode === 'cloze'){
    front.textContent = card.trans || '—';
    front.lang = 'es';
  }else{
    front.textContent = reverse ? (card.trans || '—') : card.term;
    front.lang = reverse ? 'es' : 'en';
  }

  // the sentence it was met in: gapped while asking, whole once answered
  const ctx = document.getElementById('revCtx');
  if(cloze && !answering){
    ctx.innerHTML = esc(cloze.before) +
      '<b class="gap">'+'▁'.repeat(Math.min(12, Math.max(3, cloze.word.length)))+'</b>' +
      esc(cloze.after);
  }else if(card.ctx && answering){
    ctx.innerHTML = markTerm(card.ctx, card.term);
  }else{
    ctx.innerHTML = '';
  }
  show('revCtx', !!ctx.innerHTML);

  // the answer
  const back = document.getElementById('revTrans');
  back.textContent = answerText(card);
  back.lang = answerLang(card);
  show('revTrans', answering);
  const givesItAway = !answering &&
    (TYPED.includes(revMode) ? revMode !== 'listen' : reverse);
  show('revSpk', !givesItAway);
  const extra = document.getElementById('revExtra');
  extra.innerHTML = answering ? extraHtml(card) : '';
  show('revExtra', answering && !!extra.innerHTML);
  show('revSrc', answering && !!card.book && booksCache.some(b=>b.id === card.book));

  // how it is answered
  show('revShowRow', !answering && revMode === 'flip');
  show('revTypeRow', !answering && TYPED.includes(revMode));
  show('revChoiceRow', revMode === 'choice');
  if(revMode === 'choice') paintChoices(card);
  if(!answering && TYPED.includes(revMode)){
    const input = document.getElementById('revInput');
    input.value = '';
    input.placeholder = revMode === 'cloze' ? 'la palabra que falta…' : 'en inglés…';
  }
  paintVerdict(card);
  show('revGradeRow', answering);
  if(answering) paintGradeRow();
}

function markTerm(sentence, term){
  const at = sentence.toLowerCase().indexOf(term.toLowerCase());
  if(at === -1) return esc(sentence);
  return esc(sentence.slice(0, at)) + '<mark>' + esc(sentence.slice(at, at + term.length)) +
         '</mark>' + esc(sentence.slice(at + term.length));
}
// Everything the reader saw in the popup when they saved the word, given back
// at the moment it is most useful: right after they tried to remember it.
function extraHtml(card){
  const head = [];
  if(card.phon) head.push(esc(card.phon));
  if(card.lemma) head.push('≈ '+esc(card.lemma));
  let html = head.length ? '<div class="rev-phon">'+head.join(' · ')+'</div>' : '';
  if(revMode === 'listen' && card.trans)
    html += '<div class="rev-mean">🇪🇸 '+esc(card.trans)+'</div>';
  if(card.def) html += '<div class="rev-def">'+esc(card.def)+'</div>';
  return html;
}

function paintChoices(card){
  const row = document.getElementById('revChoiceRow');
  const answering = revPhase === 'answer';
  const right = normalizeAnswer(answerText(card));
  row.innerHTML = choicesFor(card).map(text=>{
    let cls = 'revchoice';
    if(answering && normalizeAnswer(text) === right) cls += ' ok';
    else if(answering && text === revChosen) cls += ' no';
    return `<button class="${cls}" data-act="choose" data-text="${esc(text)}"${answering ? ' disabled' : ''}>${esc(text)}</button>`;
  }).join('');
}

const VERDICTS = {
  right: { cls:'ok', text: t=>'✅ Correcto' },
  close: { cls:'ok', text: t=>'✅ Casi: se escribe «'+t+'»' },
  wrong: { cls:'no', text: t=>'❌ Era «'+t+'»' },
  blank: { cls:'no', text: t=>'La respuesta era «'+t+'»' }
};
function paintVerdict(card){
  const el = document.getElementById('revVerdict');
  const v = revPhase === 'answer' && revVerdict ? VERDICTS[revVerdict] : null;
  el.className = 'rev-verdict' + (v ? ' '+v.cls : '');
  el.textContent = v ? v.text(answerText(card)) : '';
  el.classList.toggle('hidden', !v);
}
// An exercise the app could grade itself has already answered the question the
// three buttons are asking, so it only offers the honest ones.
function paintGradeRow(){
  const allow = revVerdict === 'right' ? [1, 2]
              : revVerdict === 'close' ? [0, 1, 2]
              : revVerdict             ? [0]
                                       : [0, 1, 2];
  [...document.getElementById('revGradeRow').querySelectorAll('button')].forEach(b=>{
    b.classList.toggle('hidden', !allow.includes(Number(b.dataset.arg)));
  });
}
function paintDone(){
  const today = statFor(todayISO());
  const streak = streakDays();
  document.getElementById('revDone').innerHTML = '¡Repaso terminado! 🎉<span class="rev-tally">' +
    today.rev + ' ' + (today.rev === 1 ? 'repaso' : 'repasos') + ' hoy' +
    (streak ? ' · 🔥 racha de '+streak+' '+(streak === 1 ? 'día' : 'días') : '') + '</span>';
}

/* ---- ANSWERING ---- */
function revealCard(){
  if(!revCard || revPhase === 'answer') return;
  // giving up on a word you were asked to produce is an answer too
  if(TYPED.includes(revMode)) revVerdict = checkAnswer(document.getElementById('revInput').value);
  revPhase = 'answer';
  renderReview();
}
function checkTyped(){ revealCard(); }
function chooseOption(text){
  if(!revCard || revPhase === 'answer') return;
  revChosen = text;
  revVerdict = normalizeAnswer(text) === normalizeAnswer(answerText(revCard)) ? 'right' : 'wrong';
  revPhase = 'answer';
  renderReview();
}
// The keyboard and the auto-graded exercises both need "carry on with whatever
// this answer earned" without picking a button by hand.
function gradeDefault(){
  if(revPhase !== 'answer') return;
  if(!revVerdict) return;                       // a flashcard is graded by hand
  gradeCard(revVerdict === 'wrong' || revVerdict === 'blank' ? 0 : 1);
}
function gradeIfAllowed(grade){
  const btn = document.querySelector('#revGradeRow button[data-arg="'+grade+'"]');
  if(btn && !btn.classList.contains('hidden')) gradeCard(grade);
}

// A failed or still-learning card is put back a few places along, not at the
// very end: it has to come round again while the reader still remembers seeing
// it, which is the whole point of a learning step.
function requeue(card, after){
  revQueue.splice(Math.min(after, revQueue.length), 0, card);
}

// grade: 0 again, 1 good, 2 easy
function gradeCard(grade){
  if(!revCard) return;
  const c = revCard;
  const first = isNew(c);
  report('review_grade', {
    label: ['again','good','easy'][grade] || String(grade),
    mode: revMode,
    word: reportContent(c.term)
  });

  if(grade === 0){
    c.lapses = (c.lapses || 0) + 1;
    if(c.reps) c.ease = Math.max(1.3, Math.min(3, (c.ease || 2.5) - 0.2));
    c.reps = 0; c.step = 0; c.interval = 0;
    c.due = todayISO();
  }else if(!c.reps){
    // still learning: it has to come back inside this session before it is
    // scheduled by date at all
    c.step = (c.step || 0) + (grade === 2 ? LEARN_STEPS : 1);
    if(c.step >= LEARN_STEPS){
      c.reps = 1;
      c.interval = grade === 2 ? 3 : 1;
      c.due = addDays(c.interval);
    }else{
      c.reps = 0;              // stored explicitly: the card is shaped, not half-written
      c.interval = 0;
      c.due = todayISO();
    }
  }else{
    c.ease = Math.max(1.3, Math.min(3, (c.ease || 2.5) + (grade === 2 ? 0.15 : 0)));
    c.reps++;
    if(c.reps === 2) c.interval = grade === 2 ? 10 : 6;
    else c.interval = Math.max(1, Math.round((c.interval || 1) * c.ease * (grade === 2 ? 1.3 : 1)));
    c.due = addDays(c.interval);
  }
  c.reviewed = todayISO();
  if((c.lapses || 0) >= LEECH_LAPSES && !c.leech){
    c.leech = true;
    toast('«'+c.term+'» se te resiste: en pausa. Reactívala en ⭐ Vocabulario.');
  }
  DB.vocab = revVocab;
  bumpStat('rev');
  if(first) bumpStat('new');

  if(c.leech) revQueue = revQueue.filter(x=>x !== c);
  else if(!c.reps) requeue(c, grade === 0 ? 2 : 4);
  nextCard();
  updateDueBadge();
}

function closeReview(){
  closeModal('reviewModal');
  revCard = null; revQueue = [];
  updateDueBadge();
  if(document.getElementById('vocabModal').style.display === 'flex') renderVocab();
  if(current) renderChapter();
}

// Back to the page the word was met on, with it highlighted. A word practised
// where it was read is the one thing a reader with a book can do that a stack
// of flashcards cannot.
function goToSource(){
  const c = revCard;
  if(!c || !c.book) return;
  const book = booksCache.find(b=>b.id === c.book);
  if(!book){ toast('Ese libro ya no está en tu biblioteca'); return; }
  closeReview();
  closeModal('vocabModal');
  searchTerm = c.term.toLowerCase();
  openBook(book.id);
  goToChapter(Math.min(Math.max(c.chapter || 0, 0), book.chapters.length - 1));
  requestAnimationFrame(()=>{
    const first = document.querySelector('#readerText .w.hit');
    if(first) first.scrollIntoView({ block:'center' });
  });
}

// always the English side, whichever way round the card is shown
document.getElementById('revSpk').addEventListener('click', ()=>{
  if(!revCard) return;
  report('speak', { word: reportContent(revCard.term) });
  pronounce(revCard.audio, revCard.term);
});
document.getElementById('revChoiceRow').addEventListener('click', e=>{
  const btn = e.target.closest('[data-act="choose"]');
  if(btn) chooseOption(btn.dataset.text);
});
['vocabSearch','vocabFilter','vocabSort'].forEach(id=>{
  document.getElementById(id).addEventListener('input', renderVocab);
});
['revModeSel','prefExercise'].forEach(id=>{
  document.getElementById(id).addEventListener('change', e=>reviewMode(e.target.value));
});

// The context and the schedule are the part worth keeping: a bare pair of
// columns is what every other export already gives you.
function exportVocab(){
  const vocab = DB.vocab;
  if(!vocab.length){ toast('No hay nada que exportar'); return; }
  const cell = v=>'"'+String(v == null ? '' : v).replace(/"/g,'""')+'"';
  const csv = ['term,lemma,translation,context,added,due,interval,lapses']
    .concat(vocab.map(v=>[v.term, v.lemma||'', v.trans||'', v.ctx||'', v.date||'',
                          v.due||'', v.interval||0, v.lapses||0].map(cell).join(',')))
    .join('\n');
  downloadBlob(new Blob([csv],{type:'text/csv'}), 'vocabulario.csv');
}

/* ============ BACKUP (export / import) ============ */
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}

function exportLibrary(){
  const vocab = DB.vocab;
  if(!booksCache.length && !vocab.length){ toast('No hay nada que exportar'); return; }
  const backup = {
    format: 'leerlibros-backup',
    version: 1,
    exported: new Date().toISOString(),
    books: booksCache,
    vocab,
    prefs: DB.prefs,
    stats: DB.stats
  };
  downloadBlob(new Blob([JSON.stringify(backup)], {type:'application/json'}),
               'leerlibros-'+new Date().toISOString().slice(0,10)+'.json');
  report('library_backup', { method: 'export' });
  toast('Copia guardada · '+booksCache.length+' libros');
}

// A backup file is user data from another device: validate every field.
function cleanBook(b){
  if(!b || typeof b !== 'object') return null;
  const chapters = Array.isArray(b.chapters) ? b.chapters.filter(c=>typeof c === 'string') : [];
  if(!chapters.length) return null;
  return {
    id: (typeof b.id === 'string' && b.id) ? b.id : uid(),
    title: (typeof b.title === 'string' && b.title.trim()) ? b.title.trim() : 'Sin título',
    chapters,
    titles: (Array.isArray(b.titles) && b.titles.length === chapters.length)
      ? b.titles.map(t => typeof t === 'string' ? t : '')
      : chapters.map(headingOf),
    pos: Number.isInteger(b.pos) ? Math.min(Math.max(b.pos, 0), chapters.length-1) : 0,
    scroll: Number.isFinite(b.scroll) ? Math.min(1, Math.max(0, b.scroll)) : 0,
    words: Number.isFinite(b.words) ? b.words : chapters.join(' ').split(/\s+/).filter(Boolean).length,
    added: Number.isFinite(b.added) ? b.added : Date.now()
  };
}
function cleanVocabItem(v){
  if(!v || typeof v !== 'object' || typeof v.term !== 'string' || !v.term.trim()) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const text = (value, max)=>typeof value === 'string' ? value.slice(0, max) : '';
  const term = v.term.trim();
  return {
    term,
    trans: text(v.trans, 300),
    kind: v.kind === 'phrase' || /\s/.test(term) ? 'phrase' : 'word',
    lemma: text(v.lemma, 60),
    phon: text(v.phon, 80),
    audio: /^https:\/\//.test(v.audio) ? v.audio : '',
    def: text(v.def, 300),
    ctx: text(v.ctx, 300),
    book: text(v.book, 40),
    chapter: Number.isInteger(v.chapter) ? Math.max(0, v.chapter) : null,
    date: typeof v.date === 'string' ? v.date : todayISO(),
    due: day.test(v.due) ? v.due : todayISO(),
    reviewed: day.test(v.reviewed) ? v.reviewed : undefined,
    interval: Number.isFinite(v.interval) ? Math.max(0, Math.round(v.interval)) : 0,
    ease: Number.isFinite(v.ease) ? Math.min(3, Math.max(1.3, v.ease)) : 2.5,
    reps: Number.isInteger(v.reps) ? Math.max(0, v.reps) : 0,
    step: Number.isInteger(v.step) ? Math.max(0, v.step) : 0,
    lapses: Number.isInteger(v.lapses) ? Math.max(0, v.lapses) : 0,
    leech: !!v.leech
  };
}

// Import merges: whatever is already in the library is never overwritten.
async function importLibrary(file){
  if(!file) return;
  let data;
  try{ data = JSON.parse(await file.text()); }
  catch(err){ console.error(err); toast('No se pudo leer el archivo'); return; }
  if(!data || typeof data !== 'object' || !Array.isArray(data.books)){
    toast('Ese archivo no es una copia de LeerLibros'); return;
  }

  const known = new Set(booksCache.map(b=>b.id));
  const newBooks = data.books.map(cleanBook).filter(b=>b && !known.has(b.id));
  if(newBooks.length){
    booksCache = booksCache.concat(newBooks);
    sortBooks();
    try{
      if(idb) await idbTx(IDB_STORE, 'readwrite', s=>{ newBooks.forEach(b=>s.put(b)); });
      else writeJSON('ll_books', booksCache);
    }catch(err){
      console.error('Import failed', err);
      toast('No se pudieron guardar los libros importados');
    }
  }

  let newWords = 0;
  if(Array.isArray(data.vocab)){
    const vocab = DB.vocab;
    const seen = new Set(vocab.map(v=>String(v.term||'').toLowerCase()));
    data.vocab.map(cleanVocabItem).forEach(v=>{
      if(!v || seen.has(v.term.toLowerCase())) return;
      seen.add(v.term.toLowerCase());
      vocab.push(v); newWords++;
    });
    if(newWords) DB.vocab = vocab;
  }

  // Day rows are merged, never replaced: restoring an old copy must not wipe
  // out the days studied since it was made.
  if(data.stats && typeof data.stats.log === 'object' && data.stats.log){
    const stats = DB.stats;
    const log = stats.log || (stats.log = {});
    for(const day of Object.keys(data.stats.log)){
      if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      const row = data.stats.log[day] || {};
      const here = log[day] || { rev:0, new:0 };
      log[day] = {
        rev: Math.max(here.rev || 0, Number(row.rev) || 0),
        new: Math.max(here.new || 0, Number(row.new) || 0)
      };
    }
    DB.stats = stats;
  }

  if(data.prefs && typeof data.prefs === 'object'){
    if(['light','sepia','dark'].includes(data.prefs.theme)) setTheme(data.prefs.theme);
    if(Number.isFinite(data.prefs.fs)){
      const p = DB.prefs;
      p.fs = Math.min(34, Math.max(14, data.prefs.fs));
      DB.prefs = p;
      document.documentElement.style.setProperty('--fs', p.fs+'px');
    }
  }

  renderLibrary();
  updateDueBadge();
  report('library_backup', { method: 'import' });
  if(current) renderChapter();
  if(!newBooks.length && !newWords) toast('Esa copia ya estaba en tu biblioteca');
  else toast('Importado · '+newBooks.length+' libros y '+newWords+' palabras');
}

/* ============ MODALS ============ */
function openPaste(){
  document.getElementById('pasteTitle').value='';
  document.getElementById('pasteText').value='';
  openModal('pasteModal');
}
function savePaste(){
  const title = document.getElementById('pasteTitle').value.trim() || 'Texto pegado';
  const text = document.getElementById('pasteText').value;
  if(!text.trim()){ toast('Pega algún texto primero'); return; }
  closeModal('pasteModal');
  const b = saveBookFromText(title, text);
  openBook(b.id);
}
const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
let focusBeforeModal = null;

// A modal that does not take the focus is invisible to a keyboard or a screen
// reader, and one that does not hold it lets you tab out into the page behind.
function openModal(id){
  const modal = document.getElementById(id);
  focusBeforeModal = document.activeElement;
  modal.style.display = 'flex';
  const first = modal.querySelector(FOCUSABLE);
  if(first) first.focus();
}
function closeModal(id){
  const modal = document.getElementById(id);
  if(!modal || modal.style.display === 'none') return;
  modal.style.display = 'none';
  if(focusBeforeModal && document.contains(focusBeforeModal)) focusBeforeModal.focus();
  focusBeforeModal = null;
}
document.addEventListener('keydown', e=>{
  if(e.key !== 'Tab') return;
  const modal = openModals()[0];
  if(!modal) return;
  const items = [...modal.querySelectorAll(FOCUSABLE)].filter(el=>el.offsetParent !== null);
  if(!items.length) return;
  const first = items[0], last = items[items.length-1];
  if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
});
[...document.querySelectorAll('.modal-bg')].forEach(m=>{
  m.addEventListener('click', e=>{ if(e.target===m) m.style.display='none'; });
});

/* ============ DROPZONE ============ */
const dz = document.getElementById('dropzone');
['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
['dragleave','drop'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove('drag');}));
dz.addEventListener('drop', e=>{ if(e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
window.addEventListener('dragover', e=>e.preventDefault());
window.addEventListener('drop', e=>e.preventDefault());

/* ============ REPORTING ============ */
// analytics.js is a separate file and a tracker blocker may well remove it:
// measuring must never break the thing being measured.
function report(name, params){
  try{ if(window.llTrack) window.llTrack(name, params); }catch(err){ /* never mind */ }
}
// Mirrors the TRACK_CONTENT switch in analytics.js, so one place governs
// whether the reader's own words leave the device.
function reportContent(value){ return window.llTrackContent ? value : undefined; }

/* ============ ACTIONS ============ */
// Every button carries data-action instead of an onclick attribute, so the
// page can run under a Content-Security-Policy with no inline scripts.
const ACTIONS = {
  goLibrary: ()=>goLibrary(),
  font: el=>changeFont(Number(el.dataset.arg)),
  theme: el=>setTheme(el.dataset.arg),
  openVocab: ()=>openVocab(),
  doInstall: ()=>doInstall(),
  openPaste: ()=>openPaste(),
  savePaste: ()=>savePaste(),
  exportLibrary: ()=>exportLibrary(),
  exportVocab: ()=>exportVocab(),
  clearVocab: ()=>clearVocab(),
  openReview: ()=>openReview(),
  revealCard: ()=>revealCard(),
  checkTyped: ()=>checkTyped(),
  goToSource: ()=>goToSource(),
  grade: el=>gradeCard(Number(el.dataset.arg)),
  closeReview: ()=>closeReview(),
  closeModal: el=>closeModal(el.dataset.arg),
  prevChapter: ()=>prevChapter(),
  nextChapter: ()=>nextChapter(),
  openSearch: ()=>openSearch(),
  openReading: ()=>openReading(),
  pref: el=>setReadingPref(el.dataset.arg),
  consent: el=>setConsent(el.dataset.arg),
  reviewDirection: ()=>reviewDirection()
};
document.addEventListener('click', e=>{
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const run = ACTIONS[el.dataset.action];
  if(run) run(el, e);
});
document.getElementById('fileInput').addEventListener('change', e=>{
  handleFiles(e.target.files);
  e.target.value = '';
});
document.getElementById('restoreInput').addEventListener('change', e=>{
  importLibrary(e.target.files[0]);
  e.target.value = '';
});

/* ============ KEYBOARD ============ */
function openModals(){
  return [...document.querySelectorAll('.modal-bg')].filter(m=>m.style.display==='flex');
}
document.addEventListener('keydown', e=>{
  // Reviewing: space reveals, 1/2/3 grade, and in a multiple choice 1-4 answer.
  // Enter carries on once the app has graded the answer itself.
  if(document.getElementById('reviewModal').style.display==='flex'){
    if(e.key==='Escape') return closeReview();
    if(e.target === document.getElementById('revInput')){
      if(e.key === 'Enter'){
        e.preventDefault();
        revPhase === 'answer' ? gradeDefault() : checkTyped();
      }
      return;
    }
    if(revPhase === 'answer'){
      if(['1','2','3'].includes(e.key)) gradeIfAllowed(Number(e.key)-1);
      else if(e.key===' ' || e.key==='Enter'){ e.preventDefault(); gradeDefault(); }
      return;
    }
    if(revMode === 'choice' && /^[1-4]$/.test(e.key)){
      const btn = document.querySelectorAll('#revChoiceRow button')[Number(e.key)-1];
      if(btn) chooseOption(btn.dataset.text);
      return;
    }
    if(e.key===' ' || e.key==='Enter'){ e.preventDefault(); revealCard(); }
    return;
  }
  const modals = openModals();
  if(modals.length){
    if(e.key==='Escape') modals.forEach(m=>closeModal(m.id));
    return;
  }
  // Never steal keys from a field the reader is typing in.
  if(/^(input|textarea|select)$/i.test(e.target.tagName||'')) return;

  // Keyboard path into the lookup: select a word or phrase with the keyboard
  // and press Enter. Making all 5.000 words tab stops would be far worse.
  if(e.key === 'Enter' && document.getElementById('readerText').contains(e.target)){
    const sel = String(window.getSelection() || '').trim();
    if(sel){
      e.preventDefault();
      const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
      showPopupAt(rect.left + window.scrollX, rect.bottom + window.scrollY + 6);
      if(sel.split(/\s+/).length > 1) lookupPhrase(sel);
      else lookupWord(sel.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''));
      return;
    }
  }
  if(document.getElementById('reader').style.display==='block'){
    if(e.key==='ArrowRight') nextChapter();
    if(e.key==='ArrowLeft') prevChapter();
    if(e.key==='Escape') hidePopup();
  }
});

/* ============ UTILS ============ */
// Safe for text nodes and for double-quoted attribute values.
function esc(s){ return (s||'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/* ============ PWA ============ */
// When a new service worker takes over, the page may still be running the code
// the previous one handed out -- which is how a deploy can leave new markup
// driven by old logic. Reloading once puts the two back in step. Reading
// position is stored, so the reader lands back where they were.
let swReloading = false;
let hadController = 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

function onControllerChange(){
  if(!hadController || swReloading) return;   // first install: nothing stale to replace
  const paste = document.getElementById('pasteModal');
  const typed = document.getElementById('pasteText');
  if(paste.style.display === 'flex' && typed.value.trim()){
    toast('Hay una versión nueva. Recarga cuando termines.');
    return;                                   // never throw away text just pasted
  }
  swReloading = true;
  reloadPage();
}
// its own function so the reload can be observed in a test: location.reload
// itself cannot be replaced
function reloadPage(){ location.reload(); }

if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('sw.js').catch(e=>console.warn('SW:', e));
  });
}
let deferredPrompt = null;

function isStandalone(){
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
// Safari does not implement beforeinstallprompt, and on iOS every browser is
// Safari underneath. Adding to the home screen there is manual, so the button
// has to be offered anyway and explain how.
function isIOS(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function showInstallButton(on){
  document.getElementById('installBtn').classList.toggle('hidden', !on);
}

const INSTALL_STEPS = {
  ios: ['Pulsa el botón <b>Compartir</b> del navegador (el cuadrado con una flecha hacia arriba).',
        'Desplázate y elige <b>«Añadir a pantalla de inicio»</b>.',
        'Confirma con <b>«Añadir»</b>. Ya la tienes junto al resto de tus apps.'],
  other: ['Abre el <b>menú</b> del navegador (⋮ o ⋯).',
          'Elige <b>«Instalar aplicación»</b> o <b>«Añadir a pantalla de inicio»</b>.',
          'Confirma. Se abrirá a pantalla completa, como una app.']
};

function showInstallHelp(){
  const steps = INSTALL_STEPS[isIOS() ? 'ios' : 'other'];
  document.getElementById('installSteps').innerHTML = steps.map(s=>`<li>${s}</li>`).join('');
  openModal('installModal');
}

window.addEventListener('beforeinstallprompt', e=>{
  e.preventDefault();
  deferredPrompt = e;
  showInstallButton(true);
});

async function doInstall(){
  if(deferredPrompt){
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    deferredPrompt = null;
    if(choice && choice.outcome === 'accepted') showInstallButton(false);
    return;
  }
  // no native prompt here: tell the reader how to do it by hand
  showInstallHelp();
}

window.addEventListener('appinstalled', ()=>{
  showInstallButton(false);
  closeModal('installModal');
  toast('¡Instalada! Ya la tienes en tu pantalla de inicio 📖');
});

// Offer it to anyone not already running the installed app, whether or not the
// browser fires the install event.
if(!isStandalone()) showInstallButton(true);

/* ============ INIT ============ */
initBooks()
  .catch(err=>console.error('Library init failed', err))
  .then(()=>{ renderLibrary(); updateDueBadge(); });
