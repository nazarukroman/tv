/**
 * The two scripts the page carries.
 *
 * `INLINE_BOOT` runs synchronously in `<head>`. It exists only to apply the
 * saved channel order before the first paint — doing it after would show all
 * twenty columns and then rearrange them, which reads as a broken page.
 * Everything else waits for `CLIENT_SCRIPT`, deferred, because nothing else
 * affects layout.
 *
 * Both are plain strings rather than a bundled module: the whole interactive
 * surface is a picker dialog, a derived strip and a minute tick, and a build
 * step for that would cost more than it returns. Should this grow a real
 * component tree, it is worth revisiting.
 */

const STORAGE_KEY = 'tv.favourites';

export const INLINE_BOOT = `
(function(){
  try{
    var raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    if(!raw) return;
    var fav = JSON.parse(raw);
    if(!Array.isArray(fav) || !fav.length) return;
    var css = fav.map(function(slug, i){
      return '[data-ch="' + slug + '"]{--c:' + (i + 2) + ';}';
    }).join('');
    css += '.guide{--cols:' + fav.length + '}';
    css += '[data-ch]:not(' + fav.map(function(s){ return '[data-ch="' + s + '"]'; }).join(',') + '){display:none}';
    var el = document.createElement('style');
    el.id = 'fav-style';
    el.textContent = css;
    document.head.appendChild(el);
  }catch(e){ /* private mode, blocked storage: fall back to all channels */ }
})();
`.trim();

export const CLIENT_SCRIPT = `
(function(){
  'use strict';
  var KEY = ${JSON.stringify(STORAGE_KEY)};
  var guide = document.querySelector('.guide');
  if(!guide) return;
  var cells = Array.prototype.slice.call(guide.querySelectorAll('.p'));
  var heads = Array.prototype.slice.call(guide.querySelectorAll('.head'));
  var strip = document.getElementById('now-strip');
  var line = document.getElementById('nowline');
  var body = document.body;
  var dayStart = Date.parse(body.dataset.day + 'T00:00:00+03:00') / 1000;
  var dayEnd = dayStart + 86400;

  function names(){
    var map = {};
    heads.forEach(function(h){ map[h.dataset.ch] = h.textContent; });
    return map;
  }
  var CHANNEL_NAMES = names();

  function readFav(){
    try{
      var raw = localStorage.getItem(KEY);
      var fav = raw ? JSON.parse(raw) : null;
      if(Array.isArray(fav) && fav.length) return fav;
    }catch(e){}
    var el = document.getElementById('fav-default');
    try{ return JSON.parse(el.textContent); }catch(e){ return heads.map(function(h){ return h.dataset.ch; }); }
  }

  function applyFav(fav){
    var css = fav.map(function(slug, i){ return '[data-ch="' + slug + '"]{--c:' + (i + 2) + ';}'; }).join('');
    css += '.guide{--cols:' + fav.length + '}';
    css += '[data-ch]:not(' + fav.map(function(s){ return '[data-ch="' + s + '"]'; }).join(',') + '){display:none}';
    var el = document.getElementById('fav-style');
    if(!el){ el = document.createElement('style'); el.id = 'fav-style'; document.head.appendChild(el); }
    el.textContent = css;
    try{ localStorage.setItem(KEY, JSON.stringify(fav)); }catch(e){}
    renderStrip();
  }

  function clock(unix){
    var d = new Date((unix + 10800) * 1000);
    return String(d.getUTCHours()).padStart(2,'0') + ':' + String(d.getUTCMinutes()).padStart(2,'0');
  }

  /* The strip is derived from the cells already in the document, so showing
     "what is on now" costs no extra bytes and stays correct on a page that was
     rendered hours ago and cached since. */
  function startOf(cell){ return +cell.dataset.s; }
  function endOf(cell){ return +cell.dataset.s + +cell.dataset.d * 60; }

  function renderStrip(){
    if(!strip) return;
    var now = Math.floor(Date.now() / 1000);
    var fav = readFav();
    var current = {};
    cells.forEach(function(c){
      var ch = c.dataset.ch;
      if(startOf(c) <= now && now < endOf(c)){ current[ch] = c; c.setAttribute('data-live',''); }
      else c.removeAttribute('data-live');
    });
    strip.textContent = '';
    fav.forEach(function(ch){
      var cur = current[ch];
      if(!cur) return;
      var left = Math.round((endOf(cur) - now) / 60);
      var card = document.createElement('a');
      card.className = 'nowcard';
      card.href = '#';
      var b = document.createElement('b'); b.textContent = CHANNEL_NAMES[ch] || ch;
      var t = document.createElement('span'); t.textContent = cur.querySelector('b').textContent;
      var i = document.createElement('i');
      i.textContent = clock(startOf(cur)) + '–' + clock(endOf(cur)) + ' · осталось ' + left + ' мин';
      card.appendChild(b); card.appendChild(t); card.appendChild(i);
      card.addEventListener('click', function(ev){ ev.preventDefault(); cur.scrollIntoView({block:'center'}); });
      strip.appendChild(card);
    });
  }

  /* Placed by row, not by pixel maths: the lattice already has a line at every
     boundary, so the marker sits between the two cells that straddle now. */
  function placeLine(){
    if(!line) return;
    var now = Math.floor(Date.now() / 1000);
    if(now < dayStart || now >= dayEnd){ line.hidden = true; return; }
    var best = null;
    cells.forEach(function(c){
      var s = startOf(c);
      if(s <= now && (!best || s > startOf(best))) best = c;
    });
    if(!best){ line.hidden = true; return; }
    var row = getComputedStyle(best).gridRowStart;
    line.style.gridRow = row;
    line.dataset.at = clock(now);
    line.hidden = false;
  }

  function scrollToNow(){
    var now = Math.floor(Date.now() / 1000);
    if(now < dayStart || now >= dayEnd) return;
    if(location.hash) return;
    var target = null;
    cells.forEach(function(c){ if(startOf(c) <= now && endOf(c) > now && !target) target = c; });
    if(target) target.scrollIntoView({block:'center'});
  }

  /* Filtering dims instead of hiding: display:none collapses the auto rows and
     the columns stop lining up by time, which is the one thing the grid is for. */
  function filter(query){
    var q = query.trim().toLowerCase().replace(/ё/g,'е');
    cells.forEach(function(c){
      if(!q){ c.removeAttribute('data-dim'); return; }
      var t = c.querySelector('b').textContent.toLowerCase().replace(/ё/g,'е');
      if(t.indexOf(q) === -1) c.setAttribute('data-dim',''); else c.removeAttribute('data-dim');
    });
  }

  function buildControls(){
    var bar = document.querySelector('.bar');
    if(!bar) return;
    var search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Поиск по дню';
    search.setAttribute('aria-label','Поиск передачи в этом дне');
    search.style.cssText = 'padding:.25rem .5rem;border:1px solid var(--line);border-radius:.35rem;background:var(--cell);color:inherit;font:inherit;min-width:9rem';
    search.addEventListener('input', function(){ filter(search.value); });
    bar.appendChild(search);

    var pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = 'Каналы';
    pick.style.cssText = 'padding:.25rem .6rem;border:1px solid var(--line);border-radius:.35rem;background:var(--cell);color:inherit;font:inherit;cursor:pointer';
    pick.addEventListener('click', openPicker);
    bar.appendChild(pick);

    document.addEventListener('keydown', function(ev){
      if(ev.key === '/' && document.activeElement !== search){ ev.preventDefault(); search.focus(); }
      if(ev.key === 'n'){ scrollToNow(); }
    });
  }

  function openPicker(){
    var fav = readFav();
    var dialog = document.createElement('dialog');
    dialog.style.cssText = 'border:1px solid var(--line);border-radius:.6rem;background:var(--bg);color:inherit;padding:1rem;max-width:24rem';
    var form = document.createElement('form');
    form.method = 'dialog';
    var title = document.createElement('p');
    title.textContent = 'Избранные каналы идут первыми';
    title.style.cssText = 'margin:0 0 .6rem;font-weight:600';
    form.appendChild(title);

    heads.forEach(function(h){
      var slug = h.dataset.ch;
      var label = document.createElement('label');
      label.style.cssText = 'display:flex;gap:.5rem;align-items:center;padding:.15rem 0';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.value = slug;
      box.checked = fav.indexOf(slug) !== -1;
      label.appendChild(box);
      label.appendChild(document.createTextNode(h.textContent));
      form.appendChild(label);
    });

    var save = document.createElement('button');
    save.type = 'submit';
    save.textContent = 'Готово';
    save.style.cssText = 'margin-top:.8rem;padding:.3rem .8rem;font:inherit;cursor:pointer';
    form.appendChild(save);
    dialog.appendChild(form);
    document.body.appendChild(dialog);

    dialog.addEventListener('close', function(){
      var picked = Array.prototype.slice.call(form.querySelectorAll('input:checked')).map(function(b){ return b.value; });
      if(picked.length) applyFav(picked);
      dialog.remove();
    });
    dialog.showModal();
  }

  buildControls();
  renderStrip();
  placeLine();
  scrollToNow();
  setInterval(function(){ renderStrip(); placeLine(); }, 60000);
})();
`.trim();
