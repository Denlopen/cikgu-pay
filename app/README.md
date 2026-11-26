# Cikgu Pay: Electron version

Desktop app (Electron) for monthly private-tuition invoices. Windows build. The released app is the Tauri build in `../tauri`; this version uses the same UI.

## How it's organised (v1.3)
Three screens in the top bar, plus the document editor:
- **This month**: one line per thing to do ("Create invoice", "Write summary", "Continue"), with a status (Not started / Late / Draft / Sent · not paid / Paid). Below it, **Waiting for payment** lists sent invoices that aren't paid, with the total owed and a **Mark paid** button (date defaults to today). The first start shows a 3-step setup (your details → bank accounts → students).
- **Invoices**: every document, filterable by student and status.
- **Settings**: your details, bank accounts, students, theme, WhatsApp message template, backup.
- **Editor**: month, price, lessons/slots, total, **Save PDF**. Rarely used fields (document type, invoice no., PDF number, extra charge, last payment line, note, greeting, delete) are under **More options**.

Saving: every change is saved automatically ("✓ All changes saved" top-right). A document goes Draft → Sent (when the PDF is saved/printed) → Paid. Before saving a PDF the app warns about common mistakes (RM 0 price, empty account number, lessons without a date/topic). Deleting a lesson, slot or document shows **Undo**. First start: a spotlight tour of the main screens (and of the editor when the first invoice is opened). It runs once, is remembered in `prefs.toursDone`, and can be replayed in Settings › Help. Text fields that suit emoji (closing message, note, greeting, WhatsApp templates, a student's default note) have a 😊 button that opens a searchable emoji picker. It inserts the emoji at the cursor and remembers the last 24 you used (`prefs.recentEmoji`). After saving, **Copy WhatsApp message** puts a ready-made message (student, month, total, bank details) on the clipboard. Data from v1.0–1.2 is upgraded automatically; old saved invoices count as Sent.

## Billing styles (set per student under Settings → Students → Billing)
| Style | What "This month" asks you to make |
|---|---|
| End of month, invoice with lesson summary | Lessons taught (date, subject: topic), last payment received, total |
| Start of month, booked slots only | Weekly slots filled from the student's schedule, "Reschedule" marks a slot (*) with the proposed new slot, Note + greeting |
| Start-of-month invoice + summary at month end | Booked-slot invoice first. At month end "This month" shows "Write summary" (or Invoices → "+ Summary"), which copies the dates into a lesson summary that shows "Status: PAID / Payment received by …" |

Each student also has their own bank account, title line, footer brand (or none) and PDF name pattern (e.g. `<name>_112026 - Invoice 02`).

## For the user
- Install: run `Cikgu-Pay-Electron-Setup-1.3.0.exe`. It installs for the current user only, no admin needed, and adds Desktop and Start Menu shortcuts.
  - Windows may say "Windows protected your PC" because the app is unsigned. Click **More info → Run anyway**. This only happens the first time.
- No install: `Cikgu-Pay-Electron-Portable-1.3.0.exe` runs directly (starts a few seconds slower).
- Everything lives in **Documents\Tuition Invoices\\**:
  - `invoice-data.json`: all students, invoices and settings (saved on every change)
  - `backups\`: a copy every day, the last 30 kept
  - `2026-08\…pdf`: exported invoices, one folder per month

## Colour themes
Pick one in Settings → Appearance: Classic (original), Catppuccin Latte / Frappé / Macchiato / Mocha, or Auto (Latte in light mode, Mocha in dark mode). Catppuccin themes also have 14 accent colours.
- Every app colour is a CSS variable (`--bg`, `--surface`, `--accent`, … at the top of `renderer/index.html`). Each theme maps the official Catppuccin palette onto those variables.
- The choice is saved in the data file (`prefs`) and cached in localStorage. A tiny script in `<head>` applies it before the page draws, so there's no flash of the wrong colours.
- The invoice paper never uses theme colours: PDFs are pixel-identical in every theme (tested).

## Smooth edition (animations)
`renderer/motion.css` + `renderer/motion.js` form an add-on layer. It wraps the app's render functions and animates the changes (FLIP list moves, page-turn on document switch, count-up totals). `scripts/editions.mjs` adds it to the page:
- `node scripts/build-html.mjs` writes `../cikgu-pay.html` (plain) and `../cikgu-pay-smooth.html`
- the Tauri app: `npm run start:smooth` / `build:win:smooth` in `../tauri`

Animations switch off when the OS "reduce motion" setting is on. Print CSS + `settle()` make sure a PDF never captures a half-finished animation.

## For development
```bash
npm install
npm start                 # run on Linux
npm run selftest          # automated UI → PDF → reload check, writes .selftest/selftest-result.json
npm run dist:win          # build dist/*.exe (needs wine on Linux)
```
- `renderer/index.html` is the whole UI. It also works as a plain web page, falling back to localStorage.
- `main.js` owns disk access and PDF export. `preload.js` is the only bridge between the page and Node.
- To release an update: bump `version` in package.json, run `npm run dist:win`, and send the new Setup exe. Installing over the old version keeps all data.
