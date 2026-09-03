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
  sortBooks();
}

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
(function initPrefs(){
  const p = DB.prefs;
  setTheme(p.theme||'light');
  document.documentElement.style.setProperty('--fs', (p.fs||20)+'px');
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
      r.onload = ()=>{ const b=saveBook(name, splitChapters(r.result)); openBook(b.id); };
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
  const blocks = text.split(/\n\n(?=## )/);
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
  const savedSet = new Set(DB.vocab.map(v=>v.term.toLowerCase()));
  const paras = text.split(/\n\s*\n/);
  container.innerHTML = paras.map(p=>{
    if(p.startsWith('## ')) return '<h2>'+wrapWords(p.slice(3), savedSet)+'</h2>';
    return '<p>'+wrapWords(p, savedSet)+'</p>';
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

// wrap each word-token in a clickable span, keep punctuation
function wrapWords(str, savedSet){
  return str.replace(/\p{L}+(?:['’-]\p{L}+)*|[^\p{L}]+/gu, tok=>{
    if(/^\p{L}/u.test(tok)){
      const cls = savedSet.has(tok.toLowerCase()) ? 'w saved' : 'w';
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

/* ============ LOOKUP (word & phrase) ============ */
const pop = document.getElementById('pop');

// The popup never interpolates text into JS: its buttons read the current
// lookup from popState, so quotes in a book or in an API reply are harmless.
let popState = { term:'', trans:'', audio:'' };
let lookupSeq = 0; // discards replies from a lookup the reader already left

pop.addEventListener('click', e=>{
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  if(btn.dataset.act === 'speak') pronounce(popState.audio, popState.term);
  else if(btn.dataset.act === 'save') saveVocab(popState.term, popState.trans);
});

document.getElementById('vocabList').addEventListener('click', e=>{
  const btn = e.target.closest('[data-act]');
  if(!btn) return;
  const i = Number(btn.dataset.i);
  if(btn.dataset.act === 'speak'){
    const v = DB.vocab[i];
    if(v) speak(v.term);
  } else if(btn.dataset.act === 'del') delVocab(i);
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
  lookupWord(word);
});

// phrase selection — works on desktop (mouse) and mobile (touch).
// When a multi-word selection exists inside the reader, show a floating
// "Traducir frase" button; tapping it translates the selected text.
const selBtn = document.getElementById('selBtn');
let selText = '';
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
function hideSelButton(){ selBtn.style.display='none'; selText=''; }

document.addEventListener('selectionchange', ()=>{
  clearTimeout(selUpdateT);
  selUpdateT = setTimeout(updateSelButton, 120);
});

// use pointerdown so it fires before the selection is cleared by the tap
selBtn.addEventListener('pointerdown', e=>{
  e.preventDefault(); e.stopPropagation();
  const txt = selText;
  if(!txt) return;
  const r = selBtn.getBoundingClientRect();
  hideSelButton();
  showPopupAt(r.left+window.scrollX, r.bottom+window.scrollY+6);
  lookupPhrase(txt);
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
    html += `<div class="err">${esc(errorMessage(s.transError || s.dictError))}</div>`;
  }

  html += `<div class="row">
    <button class="primary" data-act="save">⭐ Guardar</button>
  </div>`;
  return html;
}

// The translation and the definition are painted as each arrives, so a slow or
// dead dictionary no longer holds back the word the reader actually wants.
function lookupWord(word){
  if(!word){ hidePopup(); return Promise.resolve(); }
  const turn = ++lookupSeq;
  popState = { term: word, trans: '', audio: '' };
  const state = { word, entry: null, trans: null, dictPending: true, transPending: true,
                  dictError: null, transError: null };
  const paint = ()=>{ if(turn === lookupSeq) pop.innerHTML = wordPopupHtml(state); };
  paint();

  const translating = lookupTranslation(word).then(
    t => { state.trans = t; popState.trans = t || ''; },
    e => { state.transError = e; }
  ).then(()=>{ state.transPending = false; paint(); });

  const defining = lookupDict(word).then(
    d => { state.entry = d; popState.audio = (d && d.audio) || ''; },
    e => { state.dictError = e; }
  ).then(()=>{ state.dictPending = false; paint(); });

  return Promise.all([translating, defining]);
}

async function lookupPhrase(phrase){
  const turn = ++lookupSeq;
  popState = { term: phrase, trans: '' };
  popState.audio = '';
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
// Filling this in raises MyMemory's daily allowance a long way. It is left
// empty on purpose: the address would be public in this file.
const MYMEMORY_EMAIL = '';

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
  if(MYMEMORY_EMAIL) url += '&de='+encodeURIComponent(MYMEMORY_EMAIL);
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
function todayISO(){ return new Date().toISOString().slice(0,10); }
function addDays(n){
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0,10);
}
// Anything never reviewed, or scheduled for today or earlier, is due.
function isDue(v){ return !v.due || v.due <= todayISO(); }
function dueCount(){ return DB.vocab.filter(isDue).length; }
function dueLabel(v){
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

function saveVocab(term, trans){
  term = term.trim();
  if(!term) return;
  const vocab = DB.vocab;
  if(vocab.some(v=>v.term.toLowerCase()===term.toLowerCase())){ toast('Ya estaba en tu vocabulario'); hidePopup(); return; }
  vocab.unshift({ term, trans, date: todayISO(), due: todayISO(), interval: 0, ease: 2.5, reps: 0 });
  DB.vocab = vocab;
  toast('⭐ Guardado: '+term);
  hidePopup();
  updateDueBadge();
  if(current) renderChapter();
}
function openVocab(){
  const list = document.getElementById('vocabList');
  const vocab = DB.vocab;
  document.getElementById('vocabEmpty').classList.toggle('hidden', vocab.length>0);
  const due = dueCount();
  document.getElementById('revCount').textContent = due ? ' ('+due+')' : '';
  list.innerHTML = vocab.map((v,i)=>`
    <div class="vocab-item">
      <span class="vt" lang="en">${esc(v.term)}</span>
      <span class="vd">${esc(v.trans||'—')}</span>
      <span class="vwhen" title="Próximo repaso">${esc(dueLabel(v))}</span>
      <button class="spk" data-act="speak" data-i="${i}" title="Pronunciar">🔊</button>
      <button class="vdel" data-act="del" data-i="${i}" title="Eliminar">✕</button>
    </div>`).join('');
  document.getElementById('vocabModal').style.display='flex';
  updateDueBadge();
}
function delVocab(i){
  const vocab = DB.vocab;
  if(!vocab[i]) return;
  vocab.splice(i,1); DB.vocab = vocab;
  openVocab(); if(current) renderChapter();
}
function clearVocab(){
  if(!confirm('¿Vaciar todo el vocabulario?')) return;
  DB.vocab = []; openVocab(); if(current) renderChapter();
}

/* ============ REVIEW (spaced repetition) ============ */
// Simplified SM-2. Cards are held by reference in revVocab, so grading one
// and writing the whole array back keeps the schedule in sync.
let revVocab = null, revQueue = [], revCard = null;

function openReview(){
  revVocab = DB.vocab;
  revQueue = revVocab.filter(isDue);
  if(!revQueue.length){ toast('Nada que repasar hoy 🎉'); return; }
  for(let i = revQueue.length-1; i > 0; i--){          // shuffle
    const j = Math.floor(Math.random()*(i+1));
    [revQueue[i], revQueue[j]] = [revQueue[j], revQueue[i]];
  }
  closeModal('vocabModal');
  document.getElementById('reviewModal').style.display = 'flex';
  nextCard();
}

function nextCard(){
  revCard = revQueue.shift() || null;
  const done = !revCard;
  document.getElementById('revDone').classList.toggle('hidden', !done);
  document.getElementById('revCard').classList.toggle('hidden', done);
  document.getElementById('revShowRow').classList.toggle('hidden', done);
  document.getElementById('revGradeRow').classList.add('hidden');
  document.getElementById('revTrans').classList.add('hidden');
  document.getElementById('revProgress').textContent = done ? '' : (revQueue.length+1)+' por repasar';
  if(!done){
    document.getElementById('revTerm').textContent = revCard.term;
    document.getElementById('revTrans').textContent = revCard.trans || '—';
  }
}

function revealCard(){
  if(!revCard) return;
  document.getElementById('revTrans').classList.remove('hidden');
  document.getElementById('revShowRow').classList.add('hidden');
  document.getElementById('revGradeRow').classList.remove('hidden');
}

// grade: 0 again, 1 good, 2 easy
function gradeCard(grade){
  if(!revCard) return;
  const c = revCard;
  c.ease = Math.max(1.3, Math.min(3, (c.ease || 2.5) + (grade === 0 ? -0.2 : grade === 2 ? 0.15 : 0)));
  if(grade === 0){
    c.reps = 0;
    c.interval = 0;
  }else{
    c.reps = (c.reps || 0) + 1;
    if(c.reps === 1) c.interval = grade === 2 ? 3 : 1;
    else if(c.reps === 2) c.interval = grade === 2 ? 10 : 6;
    else c.interval = Math.max(1, Math.round((c.interval || 1) * c.ease * (grade === 2 ? 1.3 : 1)));
  }
  c.due = addDays(c.interval);
  c.reviewed = todayISO();
  DB.vocab = revVocab;
  if(grade === 0) revQueue.push(c);   // a failed card comes back this session
  nextCard();
  updateDueBadge();
}

function closeReview(){
  closeModal('reviewModal');
  revCard = null; revQueue = [];
  updateDueBadge();
  if(current) renderChapter();
}

document.getElementById('revSpk').addEventListener('click', ()=>{ if(revCard) speak(revCard.term); });
function exportVocab(){
  const vocab = DB.vocab;
  if(!vocab.length){ toast('No hay nada que exportar'); return; }
  const csv = 'term,translation,date\n'+vocab.map(v=>
    `"${v.term.replace(/"/g,'""')}","${(v.trans||'').replace(/"/g,'""')}","${v.date||''}"`).join('\n');
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
    prefs: DB.prefs
  };
  downloadBlob(new Blob([JSON.stringify(backup)], {type:'application/json'}),
               'leerlibros-'+new Date().toISOString().slice(0,10)+'.json');
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
  return {
    term: v.term.trim(),
    trans: typeof v.trans === 'string' ? v.trans : '',
    date: typeof v.date === 'string' ? v.date : todayISO(),
    due: day.test(v.due) ? v.due : todayISO(),
    interval: Number.isFinite(v.interval) ? Math.max(0, Math.round(v.interval)) : 0,
    ease: Number.isFinite(v.ease) ? Math.min(3, Math.max(1.3, v.ease)) : 2.5,
    reps: Number.isInteger(v.reps) ? Math.max(0, v.reps) : 0
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
  if(current) renderChapter();
  if(!newBooks.length && !newWords) toast('Esa copia ya estaba en tu biblioteca');
  else toast('Importado · '+newBooks.length+' libros y '+newWords+' palabras');
}

/* ============ MODALS ============ */
function openPaste(){
  document.getElementById('pasteTitle').value='';
  document.getElementById('pasteText').value='';
  document.getElementById('pasteModal').style.display='flex';
}
function savePaste(){
  const title = document.getElementById('pasteTitle').value.trim() || 'Texto pegado';
  const text = document.getElementById('pasteText').value;
  if(!text.trim()){ toast('Pega algún texto primero'); return; }
  closeModal('pasteModal');
  const b = saveBook(title, splitChapters(text));
  openBook(b.id);
}
function closeModal(id){ document.getElementById(id).style.display='none'; }
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
  grade: el=>gradeCard(Number(el.dataset.arg)),
  closeReview: ()=>closeReview(),
  closeModal: el=>closeModal(el.dataset.arg),
  prevChapter: ()=>prevChapter(),
  nextChapter: ()=>nextChapter()
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
  // Reviewing: space reveals, 1/2/3 grade.
  if(document.getElementById('reviewModal').style.display==='flex'){
    if(e.key==='Escape') return closeReview();
    const grading = !document.getElementById('revGradeRow').classList.contains('hidden');
    if(!grading && (e.key===' ' || e.key==='Enter')){ e.preventDefault(); revealCard(); }
    else if(grading && ['1','2','3'].includes(e.key)) gradeCard(Number(e.key)-1);
    return;
  }
  const modals = openModals();
  if(modals.length){
    if(e.key==='Escape') modals.forEach(m=>{ m.style.display='none'; });
    return;
  }
  // Never steal keys from a field the reader is typing in.
  if(/^(input|textarea|select)$/i.test(e.target.tagName||'')) return;
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
if('serviceWorker' in navigator){
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
  document.getElementById('installModal').style.display = 'flex';
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
