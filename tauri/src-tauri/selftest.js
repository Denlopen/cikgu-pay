// Automated check for the Tauri build. main.rs injects this into the page ONLY when
// INVOICE_SELFTEST is set. Same three flows as the Electron selftest.
// Phase 1: run the flows + export PDFs, move the invoices to another folder, "unplug" that folder, reload.
// Phase 2: the app must say it can't find the folder and refuse to save; "plug it back in", click Try again.
// Phase 3: the data must be back; move everything to the default folder again; check, then quit.
(async () => {
  const invoke = window.__TAURI__.core.invoke;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const report = (key, value) => invoke('selftest_report', { key, value });
  try {
    for (let i = 0; i < 200 && !window.__ready && !window.__missingFolder; i++) await sleep(100);
    if (!window.__ready && !window.__missingFolder) throw new Error('page never became ready');
    const phase = await invoke('selftest_phase');

    if (phase === 1) {
      await report('atStart', { schema: S.schema, tutor: S.tutor.name, students: S.students.map(s => s.name + '/' + s.plan), invoices: S.invoices.length });
      const errors = []; window.addEventListener('error', e => errors.push(e.message));
      if (!S.tutor.name) { S.tutor.name = 'Test Tutor'; S.tutor.banks.forEach(b => { b.accNo = '1111 2222'; b.accName = 'Test Tutor'; }); persist(); }
      const out = {};
      setTheme('mocha', 'blue');   // everything below runs in a dark theme; PDFs must not change
      await sleep(400);            // the Smooth edition switches theme with a short animation
      out.theme = document.documentElement.dataset.theme + '/' + document.documentElement.dataset.accent;
      // First-run tour: shows on first start; walk it with its own buttons
      for (let i = 0; i < 30 && $('#tour').hidden; i++) await new Promise(r => setTimeout(r, 100));
      out.tour = { shown: !$('#tour').hidden, steps: [] };
      for (let i = 0; i < 20 && !$('#tour').hidden; i++) { out.tour.steps.push($('#tourTitle').textContent); $('#tourNext').click(); }
      out.tour.done = S.prefs.toursDone;
      // Test fixtures: three made-up students, one per billing style (the app itself starts with none)
      const fx = [
        { name: 'Student A', code: 'TSA', rate: 100, plan: 'end', filePrefix: 'Student A', fileLabel: 'Invoice', firstSeq: 1 },
        { name: 'Student B', code: 'TSB', rate: 120, plan: 'start', filePrefix: 'Student B', fileLabel: 'Invoice', firstSeq: 1, schedule: [{ weekday: 4, time: '4-5pm' }], greeting: true, notes: 'Test note. 📚✨' },
        { name: 'Student C', code: 'TSC', rate: 100, plan: 'startSummary', filePrefix: 'Student C', fileLabel: 'Invoice', summaryLabel: 'Lesson Summary', firstSummarySeq: 1 },
      ];
      for (const f of fx) if (!S.students.some(s => s.name === f.name)) S.students.push({ ...studentDefaults(), level: 'Test', bankId: S.tutor.banks[0].id, ...f });
      // Emoji picker: insert into the closing message through the picker's own code path
      const th = document.querySelector('#view-settings [data-bind="tutor.thanks"]');
      th.value = 'Thank you very much'; th.dispatchEvent(new Event('input', { bubbles: true }));
      th.setSelectionRange(th.value.length, th.value.length); emojiTarget = th; insertEmoji(' 🌸'.trim());
      showView('settings'); th.parentElement.querySelector('.emoji-btn').click();
      const tabs = ['open:' + !$('#emojiPop').hidden + ' ih:' + innerHeight];
      for (const c of ['1', '2', '-1']) { document.querySelector('#emojiCats [data-cat="' + c + '"]').click(); tabs.push(($('#emojiPop').hidden ? 'CLOSED ' : '') + $('#emojiTitle').textContent); }
      closeEmoji(); showView('home');
      out.emoji = { thanks: S.tutor.thanks, buttons: document.querySelectorAll('.emoji-btn').length, recent: S.prefs.recentEmoji, tabs };
      if (tabs.some(t => t.startsWith('CLOSED') || t.startsWith('open:false'))) errors.push('emoji picker closed when a category was clicked');
      persist();
      const ids = Object.fromEntries(S.students.map(s => [s.name, s.id]));
      const diag = [];
      const pdf = async () => {
        // What the page looks like at print time (catches animations that would leak into the PDF)
        const cs = el => el ? getComputedStyle(el) : null;
        diag.push({ wrap: cs($('#previewWrap'))?.transform, wrapOpacity: cs($('#previewWrap'))?.opacity, paper: cs($('#paper'))?.transform,
                    anims: document.getAnimations().map(a => a.playState + ':' + (a.effect?.target?.id || a.effect?.target?.className || a.effect?.target?.tagName)) });
        const r = await savePdfFlow(); if (r.error) throw new Error('savePdf: ' + r.error); return r.path;
      };

      out.checks = []; window.preflight = async d => { out.checks.push(checkDoc(d)); return true; };   // no dialogs in the test
      const lessons = (days, ym) => days.map((d, i) => ({ ...lessonDefaults(), date: ym + '-' + d, subject: 'Math', topic: 'Topic ' + (i + 1) }));

      // 1) End of month + summary (Student A)
      const d1 = createDoc(ids['Student A'], 'end', '2026-08');
      d1.seq = 7; d1.lessons = lessons(['04', '06', '11', '13', '18', '20', '25'], '2026-08'); renderDoc();
      out.end = { pdf: await pdf(), total: totals(S.draft).grand, file: fileBaseName(), status: docStatus(d1).label };

      // 2) Start of month, booked slots (Student B), month changed like a user would, one slot rescheduled
      const d2 = createDoc(ids['Student B'], 'start', '2026-10');
      const mi = document.querySelector('#view-editor [data-bind="draft.month"]');
      mi.value = '2026-11'; mi.dispatchEvent(new Event('input', { bubbles: true }));
      d2.seq = 2;
      d2.slots[1].movedDate = '2026-11-11'; d2.slots[1].movedTime = '8 -9pm'; renderDoc();
      out.start = { pdf: await pdf(), total: totals(S.draft).grand, slots: d2.slots.map(s => s.date), file: fileBaseName(), greeting: d2.greeting };

      // 3) Start-of-month invoice -> paid -> summary at month end (Student C)
      const sid3 = ids['Student C'];
      const d3 = createDoc(sid3, 'start', '2026-10');
      d3.slots = ['05', '07', '13', '20'].map(d => ({ ...slotDefaults(), date: '2026-10-' + d, time: '8-9pm' }));
      renderDoc(); await pdf();
      markPaid(d3.id, '2026-10-06');
      showView('docs');
      document.querySelector('#histList tr[data-id="' + d3.id + '"] [data-act=summary]').click();
      S.draft.lessons.forEach((l, i) => { l.subject = 'Math'; l.topic = 'Topic ' + (i + 1); });
      S.draft.lessons[0].more.push({ subject: 'Chemistry', topic: 'Haber process' }); S.draft.seq = 10; renderDoc();
      out.summary = { pdf: await pdf(), kind: S.draft.kind, invNo: invNo(S.draft), file: fileBaseName(),
                      pay: [S.draft.payStatus, S.draft.payDate, S.draft.payRef], lessons: S.draft.lessons.length };
      showView('home');
      out.owed = [...document.querySelectorAll('#owedList .owe')].map(o => o.innerText.replace(/\n/g, ' | '));
      out.history = S.invoices.map(i => i.kind + ' ' + invNo(i) + (i.paid ? ' paid' : ''));
      out.resultBox = document.querySelector('#pdfResult').innerText;
      out.userAgent = navigator.userAgent;
      // Storage folder: move everything to another folder, as if she picked one in Settings
      const info0 = await api.storageInfo();
      const sep = info0.dir.includes('\\') ? '\\' : '/';
      const picked = info0.default_dir + '-alt';
      await invoke('selftest_mkdir', { path: picked });
      const plan = await api.storagePlan(picked);
      const mv = await api.storageMove(plan.target);
      retargetPdfs(mv.old, mv.new);
      const info1 = await renderStorage();
      openDoc(d1); const extraPdf = await pdf();   // new PDFs go to the new folder
      out.storage = { plan, moved: mv, info: info1, extraPdf,
        pdfPathsUpdated: S.invoices.filter(d => d.pdfPath).every(d => d.pdfPath.startsWith(mv.new)),
        insideProblem: (await api.storagePlan(mv.new + sep + '2026-08')).problem, samePlan: (await api.storagePlan(mv.new)).same,
        cardPath: $('#storagePath').textContent };
      if (!(plan.target === picked + sep + 'Tuition Invoices' && !plan.has_data && mv.files >= 5 && !mv.leftover && !info1.is_default
            && info1.dir === mv.new && extraPdf.startsWith(mv.new) && out.storage.pdfPathsUpdated && out.storage.insideProblem && out.storage.samePlan))
        errors.push('storage move check failed');
      out.errors = errors;
      out.printState = diag;
      await report('run', out);
      await sleep(600);              // let the queued saves reach the disk
      // "unplug the drive"
      await invoke('selftest_rename', { from: mv.new, to: mv.new + '-unplugged' });
      await report('storageDir', mv.new);
      location.reload();
    } else if (phase === 2) {
      const dir = await invoke('selftest_report', { key: 'phase2', value: 'started' }).then(() => window.__missingFolder);
      let refused = null;
      try { await invoke('save_data', { text: '{}' }); refused = false; } catch (e) { refused = String(e); }
      const p2 = { missingFolder: dir, dialog: $('#modal').hidden ? null : $('#dlgTitle').textContent,
        buttons: [...document.querySelectorAll('#dlgBtns button')].map(b => b.textContent), saveRefused: refused, ready: !!window.__ready };
      await report('missing', p2);
      // "plug it back in" and press Try again
      await invoke('selftest_rename', { from: dir + '-unplugged', to: dir });
      [...document.querySelectorAll('#dlgBtns button')].find(b => b.textContent === 'Try again').click();
    } else {
      await sleep(900);   // a tour would have started by now
      const back = await api.storageInfo();
      const reset = await api.storageReset();   // "Move back to the default folder"
      const after = await api.storageInfo();
      await report('storageBack', { foundAgain: back.dir, invoices: S.invoices.length, reset, nowDefault: after.is_default, dir: after.dir });
      retargetPdfs(reset.old, reset.new);
      await sleep(400);
      await report('afterReload', { tourShownAgain: !$('#tour').hidden, toursDone: S.prefs.toursDone, tutor: S.tutor.name, invoices: S.invoices.length, docs: S.invoices.map(d => d.kind + ' ' + invNo(d) + ' ' + docStatus(d).label), view,
        theme: document.documentElement.dataset.theme + '/' + document.documentElement.dataset.accent, savedPrefs: S.prefs });
      await invoke('selftest_finish');
    }
  } catch (e) {
    await report('error', String((e && e.stack) || e));
    await invoke('selftest_finish');
  }
})();
