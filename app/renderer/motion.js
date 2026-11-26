/* ===== Smooth edition: motion layer =====
   Loaded after the main script (see app/scripts/editions.mjs). It never changes data: it wraps
   the app's own render functions (renderLessons, renderDoc, …) and animates the difference
   between "before" and "after". Uses the Web Animations API, transform/opacity only.

   Techniques, if you want to read along:
   - FLIP (First, Last, Invert, Play): measure items before a re-render, measure again after,
     then animate each item from its old spot to its new one. Used for add/delete/sort.
   - Ghosts: a removed item, or the previous invoice page, is kept as a non-clickable copy
     that fades out on top while the new content animates in. */
(() => {
  const root = document.documentElement;
  root.classList.add('smooth');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const EASE = 'cubic-bezier(.2,.8,.2,1)';            // fast start, gentle stop
  const BOUNCE = 'cubic-bezier(.34,1.56,.64,1)';      // slight overshoot
  const T = { move: 340, enter: 280, exit: 220, page: 460 };
  const later = (ms, fn) => setTimeout(fn, ms);       // timers also run in hidden windows (unlike rAF)
  const done = (anim, fn) => { let ran = false; const once = () => { if (!ran) { ran = true; fn(); } };
    anim.finished.then(once, once); later(anim.effect.getTiming().duration + (anim.effect.getTiming().delay || 0) + 200, once); };

  // ---------- 1. Lists: items slide in, out, and to new places ----------
  const LISTS = {
    renderLessons:  { box: () => $('#lessonList'),  sel: ':scope > .box',            items: () => S.draft ? S.draft.lessons : [] },
    renderSlots:    { box: () => $('#slotList'),    sel: ':scope > .box',            items: () => S.draft ? S.draft.slots : [] },
    renderBanks:    { box: () => $('#bankList'),    sel: ':scope > .box',            items: () => S.tutor.banks },
    renderStudents: { box: () => $('#studentList'), sel: ':scope > details.student', items: () => S.students },
    renderHistory:  { box: () => $('#histList'),    sel: 'tbody > tr',               items: null,  // rows keyed by data-id
                      extra: el => el.querySelector('.pill')?.textContent },
    renderTasks:    { box: () => $('#taskList'),    sel: ':scope > .task',           items: null, key: el => el.dataset.key,
                      extra: el => el.querySelector('.pill')?.textContent },
    renderOwed:     { box: () => $('#owedList'),    sel: ':scope > .owe',            items: null },
  };
  // Each rendered element remembers which data item it shows (el.__mk), so the next render can match them up.
  function remember(list) {
    const box = list.box(); if (!box) return;
    const items = list.items ? list.items() : null;
    [...box.querySelectorAll(list.sel)].forEach((el, i) => { el.__mk = items ? items[i] : list.key ? list.key(el) : el.dataset.id; });
  }
  function animateList(list, render) {
    const box = list.box();
    if (!box || box.offsetParent === null) { render(); remember(list); return; }   // hidden list: nothing to animate
    // FIRST: where is everything now?
    const before = new Map();
    for (const el of box.querySelectorAll(list.sel))
      if (el.__mk !== undefined) before.set(el.__mk, { el, rect: el.getBoundingClientRect(), extra: list.extra?.(el) });
    const h0 = box.getBoundingClientRect().height;
    render();
    remember(list);
    // LAST: where did everything end up?
    const els = [...box.querySelectorAll(list.sel)];
    if (!before.size || !els.some(el => before.has(el.__mk))) return;  // first render, or a different invoice (page turn handles it)
    for (const el of els) {
      const prev = before.get(el.__mk);
      if (!prev) { enter(el); continue; }
      before.delete(el.__mk);
      // INVERT + PLAY: jump back to the old spot, then glide to the new one
      const r = el.getBoundingClientRect(), dx = prev.rect.left - r.left, dy = prev.rect.top - r.top;
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5)
        el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: T.move, easing: EASE });
      if (list.extra && prev.extra !== list.extra(el)) pop(el.querySelector('.pill'));
    }
    before.forEach(({ el, rect }) => exitGhost(el, rect));   // whatever is left was removed
    const h1 = box.getBoundingClientRect().height;
    if (Math.abs(h1 - h0) > 1)                                // the list grows/shrinks smoothly, so things below glide too
      box.animate([{ height: h0 + 'px', overflow: 'clip' }, { height: h1 + 'px', overflow: 'clip' }], { duration: T.move, easing: EASE });
  }
  const themeColor = name => getComputedStyle(root).getPropertyValue(name).trim();
  function enter(el) {
    el.animate([{ opacity: 0, transform: 'translateY(-10px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: T.enter, easing: EASE });
    if (el.matches('tr')) el.animate([{ backgroundColor: themeColor('--accent-soft') }, { backgroundColor: 'transparent' }], { duration: 1400, easing: 'ease-out' });
  }
  function exitGhost(el, rect) {
    if (el.matches('tr')) return;                 // table rows can't float on their own; the rows below still slide up
    el.classList.add('motion-ghost');
    el.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
    Object.assign(el.style, { position: 'absolute', left: rect.left + scrollX + 'px', top: rect.top + scrollY + 'px',
      width: rect.width + 'px', height: rect.height + 'px', margin: '0', pointerEvents: 'none', zIndex: '5', boxSizing: 'border-box' });
    document.body.appendChild(el);                // outside the list, so the app's own code never finds it
    done(el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.95)' }],
      { duration: T.exit, easing: 'ease-in', fill: 'forwards' }), () => el.remove());
  }
  function pop(el) {
    el?.animate([{ transform: 'scale(.8)', opacity: .4 }, { transform: 'scale(1)', opacity: 1 }], { duration: 360, easing: BOUNCE });
  }
  for (const [name, list] of Object.entries(LISTS)) {
    const original = window[name];
    window[name] = function (...args) { let out; animateList(list, () => { out = original.apply(this, args); }); return out; };
  }

  // ---------- 2. Screens fade in; switching invoice turns the preview like a page ----------
  // (S, $, totals, num … are the main script's top-level names; `let`/`const` ones aren't on window)
  const originalShowView = window.showView;
  window.showView = function (...args) {
    const was = document.querySelector('.view:not([hidden])')?.id;
    if (was === 'view-editor') shownDoc = null;               // leaving the editor: next open is not a page turn
    const out = originalShowView.apply(this, args);
    const now = document.querySelector('.view:not([hidden])');
    if (now && now.id !== was && window.__ready) {
      const parts = now.matches('#view-editor') ? [...now.querySelectorAll('.editor > *'), $('#previewWrap')] : [...now.querySelectorAll('.page > *')];
      parts.forEach((el, i) => el.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
        { duration: 360, delay: Math.min(i, 6) * 45, easing: EASE, fill: 'backwards' }));
    }
    return out;
  };
  let shownDoc = null;
  const originalRenderDoc = window.renderDoc;
  window.renderDoc = function (...args) {
    if (!S.draft) return originalRenderDoc.apply(this, args);
    const switching = shownDoc !== null && S.draft.id !== shownDoc;
    const ghost = switching ? paperGhost() : null;
    const out = originalRenderDoc.apply(this, args);
    shownDoc = S.draft.id;
    if (switching) {
      pageTurn(ghost);
      $('#docCard .body')?.animate([{ opacity: .35, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE });
    }
    return out;
  };
  function paperGhost() {
    const paper = $('#paper'), wrap = $('#previewWrap');
    if (!paper || paper.offsetParent === null) return null;
    const p = paper.getBoundingClientRect(), w = wrap.getBoundingClientRect();
    const holder = document.createElement('div');      // un-zoomed holder at the paper's exact spot
    holder.className = 'motion-ghost';
    Object.assign(holder.style, { position: 'absolute', left: p.left - w.left + wrap.scrollLeft + 'px', top: p.top - w.top + wrap.scrollTop + 'px',
      pointerEvents: 'none', zIndex: '2', transformOrigin: '50% 100%' });
    const copy = paper.cloneNode(true);
    copy.removeAttribute('id');
    copy.style.margin = '0';
    holder.appendChild(copy);
    wrap.appendChild(holder);
    return holder;
  }
  function pageTurn(ghost) {
    root.classList.add('motion-turning');
    const paper = $('#paper');
    paper.style.transformOrigin = '50% 100%';
    if (ghost) done(ghost.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-28px) rotate(-1deg) scale(.985)' }],
      { duration: T.page * .8, easing: EASE, fill: 'forwards' }), () => ghost.remove());
    done(paper.animate([{ opacity: 0, transform: 'translateX(32px) rotate(1deg) scale(.985)' }, { opacity: 1, transform: 'none' }],
      { duration: T.page, delay: 70, easing: EASE, fill: 'backwards' }), () => root.classList.remove('motion-turning'));
  }

  // ---------- 3. The total counts up/down to its new value ----------
  let shownTotal = null, countRun = 0;
  const originalRenderPreview = window.renderPreview;
  window.renderPreview = function (...args) {
    const out = originalRenderPreview.apply(this, args);   // sets the exact final text first
    if (!S.draft) return out;
    const el = $('#sumRight'), target = totals(S.draft).grand;
    if (shownTotal === null || !el || el.offsetParent === null || target === shownTotal) { shownTotal = target; return out; }
    const from = shownTotal, run = ++countRun, t0 = performance.now(), dur = 420;
    shownTotal = target;
    el.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.1)', color: themeColor('--accent') }, { transform: 'scale(1)' }], { duration: dur, easing: EASE });
    const step = now => {
      if (run !== countRun) return;                           // a newer change took over
      const k = Math.min(1, (now - t0) / dur), eased = 1 - Math.pow(1 - k, 3);
      el.textContent = `RM ${num(k < 1 ? Math.round(from + (target - from) * eased) : target)}`;
      if (k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return out;
  };

  // ---------- 4. Save PDF / print: finish every animation first, then celebrate ----------
  function settle() {
    document.querySelectorAll('.motion-ghost').forEach(g => g.remove());
    for (const a of document.getAnimations()) { try { a.finish(); } catch { /* endless spinners can't finish */ } }
    root.classList.remove('motion-turning');
  }
  const originalSavePdf = window.savePdfFlow;
  window.savePdfFlow = async function (...args) {
    settle();
    const r = await originalSavePdf.apply(this, args);
    const box = $('#pdfResult');
    if (r && r.path && box && !box.hidden)
      box.animate([{ opacity: 0, transform: 'translateY(6px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: BOUNCE });
    return r;
  };
  const originalPrint = window.doPrint;
  window.doPrint = function (...args) { settle(); return originalPrint.apply(this, args); };
  window.addEventListener('beforeprint', settle);

  // ---------- 5. Theme switch: new colours ripple out from the click ----------
  // View Transitions API: the browser snapshots the old look, we reveal the new one in a growing circle.
  let lastPointer = null;
  document.addEventListener('pointerdown', e => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);
  const originalSetTheme = window.setTheme;
  window.setTheme = function (...args) {
    if (!document.startViewTransition || document.hidden) return originalSetTheme.apply(this, args);
    const r = $('#themeSel').getBoundingClientRect();
    const { x, y } = lastPointer || { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    lastPointer = null;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    // The change must never depend on the animation: if the browser can't draw a frame
    // (window hidden/minimised), skip the effect after 250 ms and switch directly.
    let applied = false;
    const apply = () => { if (!applied) { applied = true; originalSetTheme.apply(this, args); } };
    const vt = document.startViewTransition(apply);
    later(250, () => { if (!applied) { try { vt.skipTransition(); } catch { /* already finished */ } apply(); } });
    vt.ready.then(() => root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
      { duration: 560, easing: EASE, pseudoElement: '::view-transition-new(root)' })).catch(() => {});
  };

  // ---------- 6. Opening the app: panels arrive one after another ----------
  root.classList.add('smooth-intro');
  const failsafe = later(3000, () => root.classList.remove('smooth-intro'));
  (function waitReady() {
    if (!window.__ready) return later(30, waitReady);
    for (const list of Object.values(LISTS)) remember(list);
    shownTotal = S.draft ? totals(S.draft).grand : null;
    clearTimeout(failsafe);
    root.classList.remove('smooth-intro');
    [...document.querySelectorAll('.topbar, .view:not([hidden]) .page > *')].forEach((el, i) =>
      el.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'none' }],
        { duration: 460, delay: 40 + Math.min(i, 6) * 70, easing: EASE, fill: 'backwards' }));
  })();
})();
