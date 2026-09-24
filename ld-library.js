/* LifeDesk Library — subject folders, one master document per subject,
   other formats stored alongside, exported to the phone as LifeDesk/<Subject>/...
   No modules, no frameworks. Load with <script src="ld-library.js"></script>
   Public API: LDLibrary.saveText(), LDLibrary.saveFile(), LDLibrary.open()        */
(function () {
  'use strict';

  var DB_NAME = 'lifedesk-library', DB_VER = 1, db = null;
  var JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  var LAST_KEY = 'ld_lib_last_subject';

  /* ---------- storage (IndexedDB) ---------- */
  function openDB() {
    if (db) return Promise.resolve(db);
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB_NAME, DB_VER);
      r.onupgradeneeded = function () {
        var d = r.result;
        if (!d.objectStoreNames.contains('subjects')) d.createObjectStore('subjects', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('items')) {
          var s = d.createObjectStore('items', { keyPath: 'id' });
          s.createIndex('subjectId', 'subjectId', { unique: false });
        }
      };
      r.onsuccess = function () { db = r.result; res(db); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode, fn) {
    return openDB().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out;
        var req = fn(s);
        if (req) req.onsuccess = function () { out = req.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  var put = function (store, v) { return tx(store, 'readwrite', function (s) { return s.put(v); }); };
  var del = function (store, id) { return tx(store, 'readwrite', function (s) { return s.delete(id); }); };
  var all = function (store) { return tx(store, 'readonly', function (s) { return s.getAll(); }); };
  function itemsFor(subjectId) {
    return tx('items', 'readonly', function (s) { return s.index('subjectId').getAll(subjectId); })
      .then(function (list) { return (list || []).sort(function (a, b) { return a.created - b.created; }); });
  }

  /* ---------- helpers ---------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function safeName(s) { return String(s || 'Untitled').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled'; }
  function fmtDate(t) { return new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function textToHtml(t) {
    return esc(t).split(/\n{2,}/).map(function (p) {
      p = p.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>');
      if (/^#{1,3}\s/.test(p)) return '<h3>' + p.replace(/^#{1,3}\s/, '') + '</h3>';
      return '<p>' + p + '</p>';
    }).join('');
  }
  function getSubjects() { return all('subjects').then(function (l) { return (l || []).sort(function (a, b) { return b.updated - a.updated; }); }); }
  function findOrCreateSubject(name) {
    name = safeName(name);
    return getSubjects().then(function (list) {
      var hit = list.filter(function (s) { return s.name.toLowerCase() === name.toLowerCase(); })[0];
      if (hit) return hit;
      var s = { id: uid(), name: name, created: Date.now(), updated: Date.now() };
      return put('subjects', s).then(function () { return s; });
    });
  }
  function touch(subject) { subject.updated = Date.now(); try { localStorage.setItem(LAST_KEY, subject.name); } catch (e) {} return put('subjects', subject); }

  /* ---------- master document (Word-compatible .doc) ---------- */
  function buildMasterDoc(subject, entries) {
    var body = entries.map(function (e, i) {
      return '<h2>' + (i + 1) + '. ' + esc(e.title) + '</h2><p class="d">Saved ' + esc(fmtDate(e.created)) + '</p>' + e.html +
        (i < entries.length - 1 ? '<br style="page-break-before:always">' : '');
    }).join('');
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">' +
      '<head><meta charset="utf-8"><title>' + esc(subject.name) + '</title><style>' +
      'body{font-family:Calibri,Arial,sans-serif;font-size:12pt;line-height:1.5}h1{font-size:20pt;color:#0b3d1c}' +
      'h2{font-size:15pt;color:#0b3d1c;border-bottom:1px solid #c9a227;padding-bottom:3pt}.d{color:#777;font-size:9pt}' +
      '</style></head><body><h1>' + esc(subject.name) + '</h1><p class="d">LifeDesk · ' + entries.length +
      ' item' + (entries.length === 1 ? '' : 's') + '</p>' + body + '</body></html>';
    return new Blob(['\ufeff' + html], { type: 'application/msword' });
  }

  /* ---------- export ---------- */
  function loadJSZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = JSZIP_URL; s.onload = function () { res(window.JSZip); };
      s.onerror = function () { rej(new Error('Could not load the zip tool. Check your connection and try again.')); };
      document.head.appendChild(s);
    });
  }
  function download(blob, filename) {
    var a = document.createElement('a'), url = URL.createObjectURL(blob);
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }
  function uniqueName(used, name) {
    var n = name, i = 2, dot = name.lastIndexOf('.');
    while (used[n.toLowerCase()]) { n = dot > 0 ? name.slice(0, dot) + ' (' + i + ')' + name.slice(dot) : name + ' (' + i + ')'; i++; }
    used[n.toLowerCase()] = 1; return n;
  }
  function buildFolderZip(subject) {
    return Promise.all([itemsFor(subject.id), loadJSZip()]).then(function (r) {
      var items = r[0], zip = new r[1](), folder = zip.folder('LifeDesk').folder(safeName(subject.name)), used = {};
      var texts = items.filter(function (i) { return i.kind === 'text'; });
      if (texts.length) folder.file(uniqueName(used, safeName(subject.name) + '.doc'), buildMasterDoc(subject, texts));
      items.filter(function (i) { return i.kind === 'file'; }).forEach(function (f) { folder.file(uniqueName(used, f.filename), f.blob); });
      return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    });
  }
  function shareOrDownload(blob, filename) {
    var file;
    try { file = new File([blob], filename, { type: blob.type }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file], title: filename }).catch(function (e) { if (e && e.name !== 'AbortError') download(blob, filename); });
    }
    download(blob, filename); return Promise.resolve();
  }

  /* ---------- UI ---------- */
  var css = '' +
    '.ldl-ov{position:fixed;inset:0;z-index:9999;background:rgba(3,10,5,.72);display:flex;align-items:flex-end;justify-content:center;font-family:inherit}' +
    '.ldl-sh{background:#0c1f12;color:#e8efe9;width:100%;max-width:560px;max-height:88vh;overflow:auto;border-radius:18px 18px 0 0;' +
    'padding:18px 18px calc(18px + env(safe-area-inset-bottom,0px));box-sizing:border-box;border-top:2px solid #c9a227}' +
    '@media(min-width:1024px){.ldl-ov{align-items:center}.ldl-sh{border-radius:14px;border:1px solid #23402c}}' +
    '.ldl-sh h3{margin:0 0 4px;font-size:18px;color:#fff}.ldl-sub{margin:0 0 14px;font-size:13px;color:#9db5a3}' +
    '.ldl-row{display:flex;align-items:center;gap:10px;padding:12px;border-radius:10px;background:#12291a;margin-bottom:8px;cursor:pointer;border:1px solid transparent}' +
    '.ldl-row.on{border-color:#c9a227;background:#17331f}.ldl-row .ic{font-size:20px}.ldl-row .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.ldl-row .mt{font-size:12px;color:#8aa592;white-space:nowrap}' +
    '.ldl-in{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid #2d4d37;background:#071209;color:#fff;font-size:16px;margin:6px 0 12px}' +
    '.ldl-bt{display:block;width:100%;padding:13px;border:0;border-radius:10px;font-size:15px;font-weight:600;margin-top:8px;cursor:pointer}' +
    '.ldl-p{background:#c9a227;color:#071209}.ldl-s{background:#1b3a25;color:#e8efe9}.ldl-g{background:transparent;color:#9db5a3}' +
    '.ldl-x{font-size:12px;color:#e07b6a;background:none;border:0;padding:4px 6px;cursor:pointer}' +
    '.ldl-lb{font-size:12px;color:#9db5a3;margin:14px 0 6px}.ldl-emp{color:#9db5a3;font-size:14px;padding:18px 0;text-align:center}' +
    '.ldl-toast{position:fixed;left:50%;bottom:calc(24px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:#c9a227;color:#071209;' +
    'padding:10px 16px;border-radius:20px;font-weight:600;font-size:14px;z-index:10000;max-width:90vw;text-align:center}';
  var styled = false, current = null;
  function ensureStyle() { if (styled) return; var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); styled = true; }
  function toast(msg) { var t = document.createElement('div'); t.className = 'ldl-toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2600); }
  function iconFor(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return { pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', csv: '📗', ppt: '📙', pptx: '📙', png: '🖼️', jpg: '🖼️', jpeg: '🖼️' }[ext] || '📄';
  }

  function sheet(html) {
    ensureStyle(); closeSheet(true);
    var ov = document.createElement('div'); ov.className = 'ldl-ov';
    ov.innerHTML = '<div class="ldl-sh" role="dialog" aria-modal="true">' + html + '</div>';
    ov.addEventListener('click', function (e) { if (e.target === ov) closeSheet(); });
    document.body.appendChild(ov); current = ov;
    // device back button closes the sheet instead of leaving the app
    try { history.pushState({ ldl: 1 }, ''); } catch (e) {}
    return ov.firstChild;
  }
  function closeSheet(silent) {
    if (!current) return;
    current.remove(); current = null;
    if (!silent && history.state && history.state.ldl) { try { history.back(); } catch (e) {} }
  }
  window.addEventListener('popstate', function () { if (current) { current.remove(); current = null; } });

  /* Save flow: pick existing subject or type a new one */
  function pickSubject(opts) {
    return getSubjects().then(function (list) {
      return new Promise(function (resolve) {
        var last = ''; try { last = localStorage.getItem(LAST_KEY) || ''; } catch (e) {}
        var pre = opts.subject || last || (list[0] && list[0].name) || '';
        var rows = list.map(function (s) {
          return '<div class="ldl-row" data-n="' + esc(s.name) + '"><span class="ic">📁</span><span class="nm">' + esc(s.name) + '</span></div>';
        }).join('');
        var el = sheet('<h3>Save to LifeDesk folder</h3><p class="ldl-sub">' + esc(opts.label) + '</p>' +
          (rows ? '<div class="ldl-lb">Your subjects</div>' + rows : '') +
          '<div class="ldl-lb">' + (rows ? 'Or start a new subject' : 'Name this subject') + '</div>' +
          '<input class="ldl-in" placeholder="e.g. Instagram Business Stack" value="' + esc(pre) + '">' +
          '<button class="ldl-bt ldl-p">Save</button><button class="ldl-bt ldl-g">Cancel</button>');
        var input = el.querySelector('.ldl-in');
        function mark() {
          var v = input.value.trim().toLowerCase();
          Array.prototype.forEach.call(el.querySelectorAll('.ldl-row'), function (r) { r.classList.toggle('on', r.getAttribute('data-n').toLowerCase() === v); });
        }
        Array.prototype.forEach.call(el.querySelectorAll('.ldl-row'), function (r) {
          r.addEventListener('click', function () { input.value = r.getAttribute('data-n'); mark(); });
        });
        input.addEventListener('input', mark); mark();
        el.querySelector('.ldl-p').addEventListener('click', function () {
          var v = input.value.trim(); if (!v) { input.focus(); return; }
          closeSheet(); resolve(v);
        });
        el.querySelector('.ldl-g').addEventListener('click', function () { closeSheet(); resolve(null); });
      });
    });
  }

  /* Library screen */
  function openLibrary() {
    return getSubjects().then(function (list) {
      return Promise.all(list.map(function (s) { return itemsFor(s.id); })).then(function (counts) {
        var rows = list.map(function (s, i) {
          return '<div class="ldl-row" data-id="' + s.id + '"><span class="ic">📁</span><span class="nm">' + esc(s.name) +
            '</span><span class="mt">' + counts[i].length + ' item' + (counts[i].length === 1 ? '' : 's') + '</span></div>';
        }).join('');
        var el = sheet('<h3>LifeDesk Library</h3><p class="ldl-sub">Everything you save, grouped by subject.</p>' +
          (rows || '<div class="ldl-emp">Nothing saved yet. Use Save on any answer or document to start your first subject folder.</div>') +
          '<button class="ldl-bt ldl-g">Close</button>');
        Array.prototype.forEach.call(el.querySelectorAll('.ldl-row'), function (r) {
          r.addEventListener('click', function () {
            var s = list.filter(function (x) { return x.id === r.getAttribute('data-id'); })[0];
            closeSheet(true); openSubject(s);
          });
        });
        el.querySelector('.ldl-g').addEventListener('click', function () { closeSheet(); });
      });
    });
  }

  function openSubject(subject) {
    return itemsFor(subject.id).then(function (items) {
      var texts = items.filter(function (i) { return i.kind === 'text'; });
      var files = items.filter(function (i) { return i.kind === 'file'; });
      var list = '';
      if (texts.length) {
        list += '<div class="ldl-lb">Master document: ' + esc(safeName(subject.name)) + '.doc</div>' +
          texts.map(function (t, i) {
            return '<div class="ldl-row" style="cursor:default"><span class="ic">📝</span><span class="nm">' + (i + 1) + '. ' + esc(t.title) +
              '</span><button class="ldl-x" data-del="' + t.id + '">Remove</button></div>';
          }).join('');
      }
      if (files.length) {
        list += '<div class="ldl-lb">Other files</div>' + files.map(function (f) {
          return '<div class="ldl-row" style="cursor:default"><span class="ic">' + iconFor(f.filename) + '</span><span class="nm">' + esc(f.filename) +
            '</span><button class="ldl-x" data-del="' + f.id + '">Remove</button></div>';
        }).join('');
      }
      var el = sheet('<h3>📁 ' + esc(subject.name) + '</h3><p class="ldl-sub">' + items.length + ' item' + (items.length === 1 ? '' : 's') +
        ' · updated ' + esc(fmtDate(subject.updated)) + '</p>' + (list || '<div class="ldl-emp">This folder is empty.</div>') +
        (items.length ? '<button class="ldl-bt ldl-p" data-a="zip">Download folder to phone</button>' : '') +
        (texts.length ? '<button class="ldl-bt ldl-s" data-a="doc">Download master document only</button>' : '') +
        '<button class="ldl-bt ldl-s" data-a="back">Back to Library</button>' +
        '<button class="ldl-bt ldl-g" data-a="delsub">Delete this subject</button>');

      Array.prototype.forEach.call(el.querySelectorAll('[data-del]'), function (b) {
        b.addEventListener('click', function () {
          if (!confirm('Remove this item from the folder?')) return;
          del('items', b.getAttribute('data-del')).then(function () { closeSheet(true); openSubject(subject); });
        });
      });
      el.querySelector('[data-a="back"]').addEventListener('click', function () { closeSheet(true); openLibrary(); });
      el.querySelector('[data-a="delsub"]').addEventListener('click', function () {
        if (!confirm('Delete "' + subject.name + '" and everything in it? This cannot be undone.')) return;
        Promise.all(items.map(function (i) { return del('items', i.id); }).concat([del('subjects', subject.id)]))
          .then(function () { closeSheet(true); openLibrary(); toast('Subject deleted'); });
      });
      var z = el.querySelector('[data-a="zip"]');
      if (z) z.addEventListener('click', function () {
        z.textContent = 'Preparing folder…'; z.disabled = true;
        buildFolderZip(subject).then(function (blob) {
          return shareOrDownload(blob, 'LifeDesk_' + safeName(subject.name).replace(/\s+/g, '-') + '.zip');
        }).then(function () { z.textContent = 'Download folder to phone'; z.disabled = false; })
          .catch(function (e) { toast(e.message || 'Download failed. Try again.'); z.textContent = 'Download folder to phone'; z.disabled = false; });
      });
      var d = el.querySelector('[data-a="doc"]');
      if (d) d.addEventListener('click', function () { shareOrDownload(buildMasterDoc(subject, texts), safeName(subject.name) + '.doc'); });
    });
  }

  /* ---------- public API ---------- */
  window.LDLibrary = {
    /* Save an answer/script. Adds it as a new section in the subject's master document.
       opts: { title, text | html, subject? }  subject pre-fills the picker (e.g. current vertical) */
    saveText: function (opts) {
      opts = opts || {};
      var title = safeName(opts.title || (opts.text || '').split('\n')[0] || 'Untitled');
      return pickSubject({ label: title, subject: opts.subject }).then(function (name) {
        if (!name) return null;
        return findOrCreateSubject(name).then(function (s) {
          var item = { id: uid(), subjectId: s.id, kind: 'text', title: title, html: opts.html || textToHtml(opts.text || ''), created: Date.now() };
          return put('items', item).then(function () { return touch(s); }).then(function () { toast('Added to "' + s.name + '"'); return item; });
        });
      });
    },
    /* Save a generated file (Excel, PDF, Word, PPT, image…) into a subject folder as its own file.
       opts: { blob, filename, subject? } */
    saveFile: function (opts) {
      opts = opts || {};
      if (!opts.blob) return Promise.reject(new Error('saveFile needs a blob'));
      var filename = safeName(opts.filename || 'file');
      return pickSubject({ label: filename, subject: opts.subject }).then(function (name) {
        if (!name) return null;
        return findOrCreateSubject(name).then(function (s) {
          var item = { id: uid(), subjectId: s.id, kind: 'file', filename: filename, mime: opts.blob.type, blob: opts.blob, created: Date.now() };
          return put('items', item).then(function () { return touch(s); }).then(function () { toast('Saved to "' + s.name + '"'); return item; });
        });
      });
    },
    open: openLibrary
  };
})();
