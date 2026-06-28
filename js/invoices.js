/**
 * BizOps · Invoice Module v3
 * Camera uses <label for="input"> instead of JS .click() — works reliably on iOS Safari PWA.
 * COGS on dashboard comes from today's scanned invoices (Store.getInvoices).
 */

const InvoiceModule = (() => {

  let photoDataUrl = null;
  let currentWeekStart = Holidays.getWeekStart();
  let editingId = null;     // id of the invoice being edited, or null when creating
  let lastScanIds = null;   // identifiers from the most recent OCR scan (for supplier learning)
  let photoChanged = false; // true once a new photo is picked this session (vs lazy-loaded)

  function init() {
    currentWeekStart = App.getWeek();   // shared across tabs
    renderForm();
    renderWeekNav();
    loadWeekInvoices();
    migrateInlinePhotos();
  }

  // One-off: move any photos still stored inline (in localStorage) up to the
  // shared store, then strip them locally. This frees the localStorage quota
  // that older builds filled by keeping base64 photos in the invoice record.
  async function migrateInlinePhotos() {
    if (!window.Sync) return;
    const inline = Store.getInvoices().filter(i => i.photoDataUrl);
    if (!inline.length) return;
    for (const inv of inline) {
      try {
        const ok = await Sync.putPhoto(inv.id, inv.photoDataUrl);
        if (ok) Store.updateInvoice(inv.id, { photoDataUrl: undefined, hasPhoto: true });
      } catch (e) { console.warn('[photo migrate]', inv.id, e.message); }
    }
    loadWeekInvoices();
  }

  function renderWeekNav() {
    const el = document.getElementById('invoice-week-nav');
    if (!el) return;
    el.innerHTML = `
      <div class="week-selector" style="margin:0 0 4px">
        <button class="week-nav-btn" id="inv-prev-week">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
        </button>
        <div class="week-info" id="inv-week-label">${Holidays.formatWeekLabel(currentWeekStart)}</div>
        <button class="week-nav-btn" id="inv-next-week">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>
    `;
    document.getElementById('inv-prev-week').addEventListener('click', () => {
      const d = new Date(currentWeekStart + 'T12:00:00');
      d.setDate(d.getDate() - 7);
      currentWeekStart = d.toISOString().slice(0, 10);
      App.setWeek(currentWeekStart);
      document.getElementById('inv-week-label').textContent = Holidays.formatWeekLabel(currentWeekStart);
      loadWeekInvoices();
    });
    document.getElementById('inv-next-week').addEventListener('click', () => {
      const d = new Date(currentWeekStart + 'T12:00:00');
      d.setDate(d.getDate() + 7);
      const next = d.toISOString().slice(0, 10);
      if (next > new Date().toISOString().slice(0, 10)) return;
      currentWeekStart = next;
      App.setWeek(currentWeekStart);
      document.getElementById('inv-week-label').textContent = Holidays.formatWeekLabel(currentWeekStart);
      loadWeekInvoices();
    });
  }

  // ── Supplier history ──────────────────────────

  function getPastSuppliers() {
    const all = Store.getInvoices();
    const seen = new Set();
    return all.map(i => i.supplier).filter(s => s && !seen.has(s) && seen.add(s)).slice(0, 20);
  }

  // ── Form ──────────────────────────────────────

  function renderForm() {
    const container = document.getElementById('invoice-form');
    if (!container) return;
    const suppliers = getPastSuppliers();
    const todayBrisbane = new Date().toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });
    const sendToXero = Store.getSettings().sendToXero !== false;   // default: on

    // When editing, pre-fill from the existing invoice. The photo (if any) lives
    // server-side now and is lazy-loaded into the preview after render.
    const editing = editingId ? Store.getInvoices().find(i => i.id === editingId) : null;
    const v = {
      supplier:  editing?.supplier || '',
      invoiceNo: editing?.invoiceNo || '',
      date:      editing?.invoiceDate || todayBrisbane,
      total:     editing?.totalIncGst != null ? editing.totalIncGst : '',
      gst:       editing?.gst != null ? editing.gst : '',
      notes:     editing?.notes || '',
    };

    container.innerHTML = `
      <!-- Photo capture -->
      <div class="section-label">Invoice photo <span style="color:var(--text-3);font-weight:400">(optional)</span></div>

      <!-- File input — no 'capture', so iOS offers Photo Library / Take Photo / Choose File -->
      <input type="file" id="inv-photo-library" accept="image/*" style="display:none">

      <!-- Single tap zone — opens the picker (camera or library) -->
      <label class="photo-zone" id="photo-zone" for="inv-photo-library" style="display:block;cursor:pointer${photoDataUrl ? ';border:2px solid var(--green-400)' : ''}">
        <div id="photo-placeholder" style="${photoDataUrl ? 'display:none' : 'display:flex'};flex-direction:column;align-items:center;padding:24px 0">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--green-400)"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
          <div style="font-size:13px;font-weight:500;color:var(--text-2);margin-top:8px">Tap to add invoice</div>
        </div>
        <img id="photo-preview" src="${photoDataUrl || ''}" style="${photoDataUrl ? 'display:block' : 'display:none'};width:100%;border-radius:var(--r-md);max-height:220px;object-fit:cover">
      </label>
      <!-- OCR scan status -->
      <div id="scan-status" style="display:none;font-size:12px;margin:6px 0 0;padding:8px 10px;border-radius:var(--r-sm);background:var(--bg-2);color:var(--text-2)"></div>

      <!-- Invoice details -->
      <div class="section-label" style="margin-top:14px">Invoice details</div>
      <div class="card">
        <div class="field-group">
          <label class="field-label">Supplier <span style="color:var(--red-500)">*</span></label>
          <input class="field-input" id="inv-supplier" list="supplier-list"
            placeholder="Supplier name" autocomplete="off" value="${escHtml(v.supplier)}">
          <datalist id="supplier-list">
            ${suppliers.map(s => `<option value="${escHtml(s)}">`).join('')}
          </datalist>
        </div>

        <div class="field-row-2">
          <div class="field-group">
            <label class="field-label">Invoice # <span style="color:var(--red-500)">*</span></label>
            <input class="field-input" id="inv-no" placeholder="INV-001" value="${escHtml(v.invoiceNo)}">
          </div>
          <div class="field-group">
            <label class="field-label">Invoice date</label>
            <input class="field-input" type="date" id="inv-date" value="${v.date}">
          </div>
        </div>

        <div class="cost-divider"></div>
        <div class="field-row-2">
          <div class="field-group">
            <label class="field-label">Total inc GST ($)</label>
            <input class="field-input" type="number" id="inv-total-gst"
              placeholder="0.00" step="0.01" inputmode="decimal" value="${v.total}">
          </div>
          <div class="field-group">
            <label class="field-label">GST amount ($)</label>
            <input class="field-input" type="number" id="inv-gst"
              placeholder="auto" step="0.01" inputmode="decimal" value="${v.gst}">
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Amount ex GST ($)</label>
          <div class="read-field highlight" id="inv-ex-gst">$—</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:4px">Posted to Xero and used in COGS. Leave GST blank to auto-calculate (÷11).</div>
        </div>

        <div class="field-group">
          <label class="field-label">Notes (optional)</label>
          <input class="field-input" id="inv-notes" placeholder="Any notes…" value="${escHtml(v.notes)}">
        </div>
      </div>

      <button class="primary-btn full-btn" id="save-invoice-btn">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        ${editing ? 'Update invoice' : (sendToXero ? 'Save &amp; send to Xero' : 'Save invoice')}
      </button>
      ${editing ? `<button class="secondary-btn full-btn" id="cancel-edit-btn" style="margin-top:8px">Cancel edit</button>` : ''}
      ${editing ? `<button class="full-btn" id="delete-invoice-btn" style="margin-top:8px;background:none;border:1px solid var(--red-500);color:var(--red-500);border-radius:var(--r-md);height:44px;font-weight:600;cursor:pointer">Delete invoice</button>` : ''}
    `;

    // Bind events programmatically — no inline onclick
    document.getElementById('inv-photo-library').addEventListener('change', handlePhoto);
    document.getElementById('inv-total-gst').addEventListener('input', calcGST);
    document.getElementById('inv-gst').addEventListener('input', calcGST);
    document.getElementById('save-invoice-btn').addEventListener('click', save);
    document.getElementById('cancel-edit-btn')?.addEventListener('click', cancelEdit);
    document.getElementById('delete-invoice-btn')?.addEventListener('click', deleteCurrent);
    if (editing) calcGST();   // show ex-GST for the prefilled total

    // Lazy-load this invoice's photo (stored server-side) into the preview.
    if (editing?.hasPhoto && !photoDataUrl && window.Sync) {
      Sync.getPhoto(editing.id).then(dataUrl => {
        if (!dataUrl || editingId !== editing.id) return;
        photoDataUrl = dataUrl;          // for display + Xero attach; not marked changed
        const preview = document.getElementById('photo-preview');
        const placeholder = document.getElementById('photo-placeholder');
        if (preview)     { preview.src = dataUrl; preview.style.display = 'block'; }
        if (placeholder) placeholder.style.display = 'none';
        const zone = document.getElementById('photo-zone');
        if (zone) zone.style.border = '2px solid var(--green-400)';
      });
    }
  }

  function deleteCurrent() {
    if (!editingId) return;
    const inv  = Store.getInvoices().find(i => i.id === editingId);
    const name = inv?.supplier ? `the ${inv.supplier} invoice` : 'this invoice';
    const xeroNote = inv?.xeroId ? '\n\nIt was sent to Xero — remember to delete that draft bill in Xero too.' : '';
    if (!confirm(`Delete ${name}? This removes it from PCW on all devices.${xeroNote}`)) return;
    Store.deleteInvoice(editingId);
    App.toast('Invoice deleted');
    editingId = null;
    resetForm();
    loadWeekInvoices();
  }

  // Load an existing invoice into the form for editing
  function startEdit(id) {
    editingId = id;
    photoDataUrl = null;   // renderForm repopulates from the invoice
    renderForm();
    document.getElementById('invoice-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function cancelEdit() {
    editingId = null;
    resetForm();
  }

  function calcGST() {
    const total = parseFloat(document.getElementById('inv-total-gst')?.value) || 0;
    const manualGst = parseFloat(document.getElementById('inv-gst')?.value);
    const gst = isNaN(manualGst) ? Math.round((total / 11) * 100) / 100 : manualGst;
    const ex  = Math.round((total - gst) * 100) / 100;
    setEl('inv-ex-gst', total ? '$' + ex.toFixed(2) : '$—');
  }

  // ── Photo handling ────────────────────────────

  function handlePhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // reset so same file can be re-selected
    const reader = new FileReader();
    reader.onload = async ev => {
      // Downscale + re-encode to JPEG: keeps localStorage small, the upload
      // within serverless limits, and normalises HEIC/PNG to a format the
      // vision API accepts.
      photoDataUrl = await compressImage(ev.target.result);
      photoChanged = true;   // a new photo was picked → push it on save
      const preview = document.getElementById('photo-preview');
      const placeholder = document.getElementById('photo-placeholder');
      if (preview)     { preview.src = photoDataUrl; preview.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      const zone = document.getElementById('photo-zone');
      if (zone) zone.style.border = '2px solid var(--green-400)';
      if (Store.getSettings().autoOcr !== false) scanPhoto();   // OCR — auto-read details (default on)
    };
    reader.readAsDataURL(file);
  }

  // Resize an image dataURL down to maxDim on its longest edge, re-encoded as
  // JPEG. Falls back to the original on any failure.
  function compressImage(dataUrl, maxDim = 1280, quality = 0.72) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // ── OCR: read invoice details from the photo via Claude vision ─
  function setScanStatus(msg, busy) {
    const el = document.getElementById('scan-status');
    if (!el) return;
    el.style.display = msg ? 'block' : 'none';
    el.innerHTML = (busy ? '<span class="spinner-dot"></span> ' : '') + escHtml(msg);
  }

  const SCAN_PROMPT =
    'You are reading a supplier invoice or receipt image. Extract these fields and reply with ' +
    'ONLY a JSON object, no prose, no code fences:\n' +
    '{"supplier": string, "invoiceNo": string, "invoiceDate": "YYYY-MM-DD", ' +
    '"totalIncGst": number, "gst": number, ' +
    '"abn": string, "phone": string, "bpayBiller": string, "bankAccount": string, ' +
    '"email": string, "addressLine": string}\n' +
    'totalIncGst is the grand total payable including GST (prefer a line labelled ' +
    'Total, Amount Due, Amount Payable, or Balance). gst is the GST/tax amount; ' +
    'if not shown, set it to null. invoiceDate is the invoice/issue date.\n' +
    'IMPORTANT about money: a leading "$" is a dollar SIGN, never a digit — read ' +
    '"$300.00" as 300.00 (not 1300 or 4300). Return amounts as plain numbers with ' +
    'no "$" or commas. GST on a GST-inclusive total is at most one-eleventh of it, ' +
    'so sanity-check that gst is not larger than totalIncGst ÷ 11.\n' +
    'The identifier fields help recognise the supplier even when their name is not printed: ' +
    'abn = the 11-digit Australian Business Number; phone = a business phone number; ' +
    'bpayBiller = the BPAY biller code; bankAccount = BSB and account number; ' +
    'email = supplier email; addressLine = the supplier street address. ' +
    'Use null for any field you cannot read. Do not guess amounts.';

  async function scanPhoto() {
    if (!photoDataUrl) return;
    const m = /^data:([^;]+);base64,(.+)$/.exec(photoDataUrl);
    if (!m) return;
    const [, mediaType, b64] = m;
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mediaType)) {
      setScanStatus('Photo saved — auto-read not supported for this image type, enter details manually', false);
      return;
    }
    setScanStatus('Reading invoice details…', true);
    try {
      const res = await fetch('/api/scan-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              { type: 'text', text: SCAN_PROMPT },
            ],
          }],
        }),
      });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error(`Server returned ${res.status}: ${raw.slice(0, 120)}`); }
      if (!res.ok) {
        let m = data.error || `Scan failed (HTTP ${res.status})`;
        if (data._debug?.origin) m += ` (origin "${data._debug.origin}" vs APP_ORIGIN "${data._debug.allowed}")`;
        throw new Error(m);
      }
      const text = (data.content || []).map(c => c.text || '').join('');
      const parsed = parseScanJson(text);
      if (!parsed) throw new Error('AI did not return invoice data');
      const { filled, supplierMatched } = applyScan(parsed);
      setScanStatus(supplierMatched
        ? 'Supplier recognised from a previous invoice — please confirm the details'
        : (filled
            ? 'Read from invoice — please check the details below'
            : 'Couldn’t read the details — please enter them manually'), false);
    } catch (err) {
      // Keep the technical detail in the console for debugging; show the user
      // a plain, friendly message.
      console.warn('[OCR]', err.message);
      setScanStatus('Couldn’t read this invoice — please enter the details manually', false);
    }
  }

  function parseScanJson(text) {
    if (!text) return null;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  // ── Supplier recognition by identifiers (ABN, phone, BPAY, etc.) ──

  const digits = s => String(s || '').replace(/\D/g, '');

  // Normalise the identifier fields from a scan into stable keys for matching.
  function extractIds(p) {
    const abn   = digits(p.abn).length === 11 ? digits(p.abn) : '';
    const phone = digits(p.phone).slice(-9);                 // ignore country/area prefixes
    const bpay  = digits(p.bpayBiller);
    const acct  = digits(p.bankAccount);
    const email = String(p.email || '').trim().toLowerCase();
    const addr  = String(p.addressLine || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return {
      abn,
      phone: phone.length >= 6 ? phone : '',
      bpay:  bpay.length  >= 3 ? bpay  : '',
      acct:  acct.length  >= 6 ? acct  : '',
      email,
      addr:  addr.length  >= 8 ? addr  : '',
    };
  }

  function hasAnyId(ids) {
    return !!(ids && (ids.abn || ids.phone || ids.bpay || ids.acct || ids.email || ids.addr));
  }

  // Find a learned supplier whose fingerprint shares a strong identifier.
  // Priority: ABN > BPAY > bank account > phone > email > address.
  function matchSupplier(ids) {
    if (!hasAnyId(ids)) return null;
    const fps = Store.getSupplierFingerprints();
    const keys = ['abn', 'bpay', 'acct', 'phone', 'email', 'addr'];
    for (const k of keys) {
      if (!ids[k]) continue;
      const fp = fps.find(f => f.ids && f.ids[k] && f.ids[k] === ids[k]);
      if (fp) return fp.supplier;
    }
    return null;
  }

  // Record/strengthen the association between a supplier name and these ids.
  function learnSupplier(supplier, ids) {
    supplier = (supplier || '').trim();
    if (!supplier || !hasAnyId(ids)) return;
    const fps = Store.getSupplierFingerprints();
    let fp = fps.find(f => f.supplier.toLowerCase() === supplier.toLowerCase());
    if (!fp) { fp = { supplier, ids: {}, count: 0 }; fps.push(fp); }
    fp.supplier = supplier;                 // keep latest casing
    fp.ids = fp.ids || {};
    for (const k of ['abn', 'bpay', 'acct', 'phone', 'email', 'addr']) {
      if (ids[k]) fp.ids[k] = ids[k];       // accumulate identifiers seen for this supplier
    }
    fp.count = (fp.count || 0) + 1;
    fp.updatedAt = new Date().toISOString();
    Store.saveSupplierFingerprints(fps);
  }

  // Populate the form from the parsed result. Returns { filled, supplierMatched }.
  function applyScan(p) {
    let filled = false;
    const setVal = (id, val) => {
      if (val == null || val === '') return;
      const el = document.getElementById(id);
      if (el) { el.value = val; filled = true; }
    };

    // Remember the identifiers from this scan so we can learn the supplier on save.
    lastScanIds = extractIds(p);

    let supplier = (p.supplier || '').trim();
    let supplierMatched = false;
    // If the supplier name wasn't printed, try to recognise it from identifiers
    // learned on previous invoices (ABN, phone, BPAY, bank account, email…).
    if (!supplier) {
      const match = matchSupplier(lastScanIds);
      if (match) { supplier = match; supplierMatched = true; }
    }

    if (supplier) setVal('inv-supplier', supplier);
    setVal('inv-no', p.invoiceNo);
    if (/^\d{4}-\d{2}-\d{2}$/.test(p.invoiceDate || '')) setVal('inv-date', p.invoiceDate);
    if (typeof p.totalIncGst === 'number') setVal('inv-total-gst', p.totalIncGst);
    if (typeof p.gst === 'number')         setVal('inv-gst', p.gst);
    calcGST();
    return { filled, supplierMatched };
  }

  // ── Save ──────────────────────────────────────

  async function save() {
    const supplier  = document.getElementById('inv-supplier')?.value?.trim();
    const invoiceNo = document.getElementById('inv-no')?.value?.trim();
    const totalGst  = parseFloat(document.getElementById('inv-total-gst')?.value) || 0;

    if (!supplier)     { App.toast('Supplier name is required', 'warning'); return; }
    if (!invoiceNo)    { App.toast('Invoice number is required', 'warning'); return; }
    if (!totalGst)     { App.toast('Enter the invoice total', 'warning'); return; }

    // Learn supplier ↔ identifiers from this scan so future invoices auto-fill —
    // including ones that don't print the supplier name.
    if (lastScanIds) learnSupplier(supplier, lastScanIds);

    const manualGst = parseFloat(document.getElementById('inv-gst')?.value);
    const gst   = isNaN(manualGst) ? Math.round((totalGst / 11) * 100) / 100 : manualGst;
    const exGst = Math.round((totalGst - gst) * 100) / 100;

    const btn = document.getElementById('save-invoice-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const existing = editingId ? Store.getInvoices().find(i => i.id === editingId) : null;

    // The invoice date drives which week the cost lands in. Fall back to today
    // (Brisbane) only if the date field was somehow left blank.
    const invoiceDate = document.getElementById('inv-date')?.value
      || new Date().toLocaleDateString('sv-SE', { timeZone: 'Australia/Brisbane' });

    // Whether this invoice has a photo (stored server-side, not in localStorage).
    const hasPhoto = editingId
      ? (photoChanged ? !!photoDataUrl : !!existing?.hasPhoto)
      : !!photoDataUrl;

    const invoiceData = {
      supplier,
      invoiceNo,
      invoiceDate,
      totalIncGst: totalGst,
      gst,
      subtotal:    exGst,
      notes:       document.getElementById('inv-notes')?.value || '',
      // Cost the invoice into the week of its invoice date, not the entry date,
      // so it's always reported in the period it belongs to.
      date:        invoiceDate,
      hasPhoto,
      // Pass the existing Xero id so the proxy updates that bill instead of creating one
      xeroId:      existing?.xeroId,
    };

    // Persist metadata and return the invoice id (new or existing).
    const persist = (extra) => {
      if (editingId) { Store.updateInvoice(editingId, { ...invoiceData, ...extra }); return editingId; }
      return Store.saveInvoice({ ...invoiceData, ...extra }).id;
    };
    // Push the photo to the shared store (only when a new one was picked).
    const pushPhoto = (id) => {
      if (photoChanged && photoDataUrl && id && window.Sync) Sync.putPhoto(id, photoDataUrl);
    };

    // When off, the bill already reaches Xero another way (e.g. email forwarding).
    // We still record it locally so it counts toward COGS/cost reporting.
    const sendToXero = Store.getSettings().sendToXero !== false;

    try {
      if (!sendToXero) {
        pushPhoto(persist({ status: 'local', error: null }));
        App.toast(editingId
          ? `${supplier} updated · $${exGst.toFixed(2)} ex GST`
          : `${supplier} · $${exGst.toFixed(2)} ex GST saved`);
      } else {
        const xeroBill = await XeroAPI.createDraftBill(invoiceData);
        const xeroId = xeroBill?.id || invoiceData.xeroId;
        const id = persist({ xeroId, status: 'synced', error: null });
        pushPhoto(id);
        // Append the photo to the Xero bill (best-effort — never blocks the save)
        if (xeroId && photoDataUrl) {
          XeroAPI.attachToBill(xeroId, photoDataUrl, invoiceNo)
            .catch(e => console.warn('[Xero attach]', e.message));
        }
        App.toast(editingId
          ? `${supplier} updated · $${exGst.toFixed(2)} ex GST`
          : `${supplier} · $${exGst.toFixed(2)} ex GST sent to Xero`);
      }
      editingId = null;
      resetForm();
      loadWeekInvoices();
    } catch (err) {
      pushPhoto(persist({ status: 'pending', error: err.message }));
      App.toast(editingId ? 'Updated locally — Xero sync failed' : 'Saved locally — Xero sync failed', 'warning');
      editingId = null;
      resetForm();
      loadWeekInvoices();
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
  }

  function resetForm() {
    photoDataUrl = null;
    photoChanged = false;
    lastScanIds = null;
    renderForm();
  }

  // ── Week invoice list ─────────────────────────

  function loadWeekInvoices() {
    const weekEnd = Holidays.getWeekEnd(currentWeekStart);
    const all = Store.getInvoices();
    const invoices = all.filter(inv => inv.date >= currentWeekStart && inv.date <= weekEnd);

    const list = document.getElementById('invoice-list');
    if (!list) return;
    if (!invoices.length) {
      list.innerHTML = '<div class="empty-state">No invoices this week</div>';
      return;
    }
    list.innerHTML = '<div class="card">' + invoices.map(inv => `
      <div class="invoice-item" style="cursor:pointer" onclick="InvoiceModule.startEdit('${inv.id}')" title="Tap to edit">
        <div class="invoice-icon">
          ${(inv.hasPhoto || inv.photoDataUrl)
            ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--green-500)"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>`
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`
          }
        </div>
        <div class="invoice-info">
          <div class="invoice-supplier">${escHtml(inv.supplier || '—')}</div>
          <div class="invoice-meta">${inv.date || '—'} · ${inv.invoiceNo || '—'} · ex GST $${(inv.subtotal || 0).toFixed(2)}</div>
        </div>
        <div class="invoice-right">
          <div class="invoice-amount">$${(inv.totalIncGst || inv.total || 0).toFixed(2)}</div>
          <span class="invoice-status ${inv.status === 'pending' ? 'status-draft' : 'status-synced'}">
            ${inv.status === 'synced' ? 'In Xero' : inv.status === 'local' ? 'Saved' : 'Pending'}
          </span>
        </div>
      </div>
    `).join('') + '</div>';
  }

  // Refresh just the save button's label (e.g. after the Send-to-Xero toggle
  // changes) without re-rendering the form, so typed values are preserved.
  function updateSaveButtonLabel() {
    const btn = document.getElementById('save-invoice-btn');
    if (!btn) return;
    const sendToXero = Store.getSettings().sendToXero !== false;
    const label = editingId ? 'Update invoice' : (sendToXero ? 'Save &amp; send to Xero' : 'Save invoice');
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg> '
      + label;
  }

  // ── Helpers ───────────────────────────────────

  function setEl(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
  function escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Re-render the week's invoice list (used by live sync when another device
  // adds/edits an invoice).
  function reloadList() { if (document.getElementById('invoice-list')) loadWeekInvoices(); }

  return { init, calcGST, save, startEdit, cancelEdit, updateSaveButtonLabel, reloadList };

})();
