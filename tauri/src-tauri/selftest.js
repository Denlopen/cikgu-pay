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
      // First-run setup, driven through its own buttons: two bank accounts, a student with a level and the 2nd account
      const type = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
      showView('home');
      const wiz = { shown: !$('#welcome').hidden };
      $('#wizNext').click();                                   // step 2: banks
      $('#wizAddBank').click();
      const rows = document.querySelectorAll('#wizBanks .wizrow');
      type(rows[1].querySelector('[data-bf=bank]'), 'CIMB'); type(rows[1].querySelector('[data-bf=accNo]'), '8000 1111 22');
      wiz.banks = S.tutor.banks.map(b => b.bank + ' ' + b.accNo);
      $('#wizNext').click();                                   // step 3: students
      wiz.bankPickerShown = !$('#wizAddRow .wizbank').hidden;
      $('#wizName').value = 'Student W'; $('#wizLevel').value = 'Year 10'; $('#wizPlan').value = 'end'; $('#wizRate').value = '90';
      $('#wizBank').value = S.tutor.banks[1].id; $('#wizAdd').click();
      const sw = S.students.find(x => x.name === 'Student W');
      wiz.student = sw && { level: sw.level, rate: sw.rate, bank: bankById(sw.bankId).bank, plan: sw.plan };
      wiz.listText = $('#wizStudents').innerText.replace(/\s+/g, ' ').trim();
      $('#wizNext').click();                                   // Done
      wiz.done = S.prefs.setupDone && $('#welcome').hidden;
      sw.code = 'TSW';
      // Its invoice shows "Student W (Year 10)" and the CIMB account; one invoice can use another account
      const dw = createDoc(sw.id, 'end', '2026-09'); dw.lessons = [{ ...lessonDefaults(), date: '2026-09-02', subject: 'Math', topic: 'Sets' }]; renderDoc();
      const paperText = () => $('#paper').innerText;
      wiz.paper = { nameLevel: paperText().includes('Student W (Year 10)'), cimb: paperText().includes('8000 1111 22') };
      $('#docBankSel').value = S.tutor.banks[0].id; $('#docBankSel').dispatchEvent(new Event('change'));
      wiz.override = { first: paperText().includes(S.tutor.banks[0].accNo) && !paperText().includes('8000 1111 22'), wa: waMessage(dw).includes(S.tutor.banks[0].accNo), student: bankById(sw.bankId).bank };
      $('#docBankSel').value = ''; $('#docBankSel').dispatchEvent(new Event('change'));
      wiz.backToUsual = paperText().includes('8000 1111 22');
      // a sent invoice keeps its account when the student's usual account changes
      markSent(dw); sw.bankId = S.tutor.banks[0].id; renderDoc();
      wiz.keptAfterSend = paperText().includes('8000 1111 22');
      sw.code = ''; wiz.noCodeWarning = checkDoc({ ...dw, invNo: '' }).some(x => x.includes('short code')); sw.code = 'TSW';
      S.invoices.splice(S.invoices.indexOf(dw), 1); S.students.splice(S.students.indexOf(sw), 1); S.draft = null; showView('home');
      out.wizard = wiz;
      if (!(wiz.shown && wiz.banks.length === 2 && wiz.bankPickerShown && wiz.student?.level === 'Year 10' && wiz.student.bank === 'CIMB' && wiz.done
            && wiz.paper.nameLevel && wiz.paper.cimb && wiz.override.first && wiz.override.wa && wiz.backToUsual && wiz.keptAfterSend && wiz.noCodeWarning))
        errors.push('setup / bank account check failed');
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
      // 4) Siblings paid together (two made-up children): linked in Settings, one combined invoice
      for (const f of [{ name: 'Student D', level: 'Year 9', code: 'TSD', rate: 100, filePrefix: 'Dee', plan: 'end' },
                       { name: 'Student E', level: 'Year 5', code: 'TSE', rate: 80, filePrefix: 'Eee', plan: 'start' }])
        S.students.push({ ...studentDefaults(), bankId: S.tutor.banks[0].id, fileLabel: 'Invoice', ...f });
      persist(); showView('settings');
      $('#addFamily').click();
      const famPick = async name => { const sel = document.querySelector('#familyList .fam:last-child select[data-act=famAdd]');
        sel.value = S.students.find(x => x.name === name).id; sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(80); };
      await famPick('Student D'); await famPick('Student E');
      const fam = { billingDialog: $('#modal').hidden ? null : $('#dlgTitle').textContent };
      document.querySelector('#dlgBtns .primary')?.click(); await sleep(80);     // "Change and add"
      const famObj = S.families[S.families.length - 1];
      fam.members = famMembers(famObj).map(x => x.name + ':' + x.plan);
      fam.tasks = homeTasks().filter(t => /Student [DE]/.test(t.st.name)).map(t => t.st.name);
      const d5 = createDoc(famObj.id, 'end', '2026-06');
      const addL = (date, topic) => { $('#addLesson').click(); const box = $('#lessonList .box:last-child');
        for (const [f, v] of [['date', date], ['subject', 'Math'], ['topic', topic]]) type(box.querySelector('[data-f=' + f + ']'), v); };
      ['02', '03', '06', '07'].forEach((dd, i) => addL('2026-06-' + dd, 'Exam revision – all criteria ' + (i + 1)));
      document.querySelector('#kidTabs [data-kid="1"]').click();
      ['05', '07', '09'].forEach((dd, i) => addL('2026-06-' + dd, 'Algebra – simplify and solve equations ' + (i + 1)));
      const paperF = $('#paper').innerText;
      fam.tabs = $('#kidTabs').innerText.replace(/\s+/g, ' ');
      fam.parts = totals(d5).parts.map(x => x.sessions + 'x' + x.rate + '=' + x.fee);
      fam.total = totals(d5).grand; fam.invNo = invNo(d5); fam.file = fileBaseName(); fam.wa = waMessage(d5);
      fam.paper = { d: paperF.includes('Student D (Year 9)'), e: paperF.includes('Student E (Year 5)'), sumToPay: paperF.includes('Sum to pay'),
        sub: /3 Sessions/.test(paperF) && /RM 240/.test(paperF), grand: /Total sum to pay\s*RM 640/.test(paperF) };
      fam.pdf = await pdf();
      markPaid(d5.id, '2026-07-02'); fam.status = docStatus(d5).label;
      const d6 = createDoc(famObj.id, 'end', '2026-07');
      fam.next = { seq: d6.seq, lastPayRef: d6.lastPayRef, parts: d6.parts.length };
      S.invoices.splice(S.invoices.indexOf(d6), 1); S.draft = null;
      out.family = fam;
      if (!(fam.billingDialog && fam.members.join() === 'Student D:end,Student E:end' && fam.tasks.length === 1 && fam.total === 640
            && fam.invNo === '062026/TSDTSE' && fam.file === 'Dee_Eee_062026 - Invoice 01' && Object.values(fam.paper).every(Boolean)
            && fam.wa.includes('Student D & Student E') && fam.wa.includes('RM 640') && fam.status.startsWith('Paid')
            && fam.next.seq === 2 && fam.next.lastPayRef === '062026/TSDTSE'))
        errors.push('siblings on one invoice check failed');
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
      const famDoc5 = S.invoices.find(d => d.familyId);
      await report('familyAfterReload', famDoc5 ? { total: totals(famDoc5).grand, parts: famDoc5.parts.map(p => p.lessons.length), activeLessons: famDoc5.lessons.length, paid: famDoc5.paid } : null);
      await report('afterReload', { tourShownAgain: !$('#tour').hidden, toursDone: S.prefs.toursDone, tutor: S.tutor.name, invoices: S.invoices.length, docs: S.invoices.map(d => d.kind + ' ' + invNo(d) + ' ' + docStatus(d).label), view,
        theme: document.documentElement.dataset.theme + '/' + document.documentElement.dataset.accent, savedPrefs: S.prefs });
      await invoke('selftest_finish');
    }
  } catch (e) {
    await report('error', String((e && e.stack) || e));
    await invoke('selftest_finish');
  }
})();
