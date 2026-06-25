/**
 * BizOps · Invoice Module v2
 * Manual entry with required photo, supplier dropdown, GST field
 * Photo pushed to Xero as attachment on draft bill
 */

const InvoiceModule = (() => {

  let photoDataUrl = null;
  let photoBlob = null;

  function init() {
    renderForm();
    loadTodayInvoices();
    loadPendingXero();
    document.getElementById('invoice-file-input')?.addEventListener('change', handlePhoto);
  }

  // ── Supplier history dropdown ─────────────────

  function getPastSuppliers() {
    const all = Store.getInvoices();
    const seen = new Set();
    return all.map(i => i.supplier).filter(s => s && !seen.has(s) && seen.add(s)).slice(0, 20);
  }

  // ── Form ──────────────────────────────────────

  function renderForm() {
    const container = document.getElementById('invoice-form-container');
    if (!container) return;
    const suppliers = getPastSuppliers();

    container.innerHTML = `
      <!-- Photo capture — required -->
      <div class="section-label">Invoice photo <span style="color:var(--red-500)">*</span></div>
      <div class="photo-zone" id="photo-zone" onclick="InvoiceModule.triggerPhoto()">
        <div id="photo-placeholder">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--green-400)"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
          <div style="font-size:13px;font-weight:500;color:var(--text-2);margin-top:8px">Tap to photograph invoice</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:3px">Required before saving</div>
        </div>
        <img id="photo-preview" style="display:none;width:100%;border-radius:var(--r-md);max-height:220px;object-fit:cover">
      </div>
      <div style="display:flex;gap:8px;margin-bottom:4px">
        <button class="secondary-btn" style="flex:1;height:38px;font-size:13px" onclick="InvoiceModule.triggerPhoto()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
          Camera
        </button>
        <button class="secondary-btn" style="flex:1;height:38px;font-size:13px" onclick="InvoiceModule.triggerLibrary()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
          Library
        </button>
      </div>

      <!-- Supplier -->
      <div class="section-label" style="margin-top:14px">Invoice details</div>
      <div class="card">
        <div class="field-group">
          <label class="field-label">Supplier <span style="color:var(--red-500)">*</span></label>
          <input class="field-input" id="inv-supplier" list="supplier-list"
            placeholder="Supplier name" autocomplete="off">
          <datalist id="supplier-list">
            ${suppliers.map(s => `<option value="${escHtml(s)}">`).join('')}
          </datalist>
        </div>

        <div class="field-row-2">
          <div class="field-group">
            <label class="field-label">Invoice # <span style="color:var(--red-500)">*</span></label>
            <input class="field-input" id="inv-no" placeholder="INV-001">
          </div>
          <div class="field-group">
            <label class="field-label">Invoice date</label>
            <input class="field-input" type="date" id="inv-date"
              value="${new Date().toISOString().slice(0,10)}">
          </div>
        </div>

        <div class="field-group">
          <label class="field-label">Due date</label>
          <input class="field-input" type="date" id="inv-due">
        </div>

        <!-- Amounts -->
        <div class="cost-divider"></div>
        <div class="field-row-2">
          <div class="field-group">
            <label class="field-label">Total inc GST ($)</label>
            <input class="field-input" type="number" id="inv-total-gst"
              placeholder="0.00" step="0.01" inputmode="decimal"
              oninput="InvoiceModule.calcFromTotal()">
          </div>
          <div class="field-group">
            <label class="field-label">GST amount ($)</label>
            <div class="read-field" id="inv-gst-display">$—</div>
          </div>
        </div>
        <div class="field-group">
          <label class="field-label">Amount ex GST ($)</label>
          <div class="read-field highlight" id="inv-ex-gst">$—</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:4px">This is the amount posted to Xero and used in cost calculations</div>
        </div>

        <div class="field-group">
          <label class="field-label">Notes (optional)</label>
          <input class="field-input" id="inv-notes" placeholder="Any notes…">
        </div>
      </div>

      <button class="primary-btn full-btn" id="save-invoice-btn" onclick="InvoiceModule.save()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        Save &amp; send to Xero
      </button>
    `;
  }

  function calcFromTotal() {
    const total = parseFloat(document.getElementById('inv-total-gst')?.value) || 0;
    const gst = Math.round((total / 11) * 100) / 100;
    const ex  = Math.round((total - gst) * 100) / 100;
    setEl('inv-gst-display', total ? '$' + gst.toFixed(2) : '$—');
    setEl('inv-ex-gst',       total ? '$' + ex.toFixed(2)  : '$—');
  }

  // ── Photo handling ────────────────────────────

  function triggerPhoto() {
    const input = document.getElementById('invoice-file-input');
    input.setAttribute('capture', 'environment');
    input.click();
  }

  function triggerLibrary() {
    const input = document.getElementById('invoice-file-input');
    input.removeAttribute('capture');
    input.click();
  }

  function handlePhoto(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
      photoDataUrl = ev.target.result;
      photoBlob = file;
      const preview = document.getElementById('photo-preview');
      const placeholder = document.getElementById('photo-placeholder');
      if (preview) { preview.src = photoDataUrl; preview.style.display = 'block'; }
      if (placeholder) placeholder.style.display = 'none';
      const zone = document.getElementById('photo-zone');
      if (zone) zone.style.border = '2px solid var(--green-400)';
    };
    reader.readAsDataURL(file);
  }

  // ── Save ──────────────────────────────────────

  async function save() {
    const supplier = document.getElementById('inv-supplier')?.value?.trim();
    const invoiceNo = document.getElementById('inv-no')?.value?.trim();
    const totalGst = parseFloat(document.getElementById('inv-total-gst')?.value) || 0;

    // Validation
    if (!photoDataUrl) { App.toast('Please photograph the invoice first', 'warning'); return; }
    if (!supplier)  { App.toast('Supplier name is required', 'warning'); return; }
    if (!invoiceNo) { App.toast('Invoice number is required', 'warning'); return; }
    if (!totalGst)  { App.toast('Enter the invoice total', 'warning'); return; }

    const gst    = Math.round((totalGst / 11) * 100) / 100;
    const exGst  = Math.round((totalGst - gst) * 100) / 100;

    const btn = document.getElementById('save-invoice-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

    const invoiceData = {
      supplier,
      invoiceNo,
      invoiceDate: document.getElementById('inv-date')?.value,
      dueDate:     document.getElementById('inv-due')?.value || null,
      totalIncGst: totalGst,
      gst,
      subtotal:    exGst,
      notes:       document.getElementById('inv-notes')?.value || '',
      date:        new Date().toISOString().slice(0, 10),
      photoDataUrl,
    };

    try {
      const xeroBill = await XeroAPI.createDraftBill(invoiceData);
      Store.saveInvoice({ ...invoiceData, xeroId: xeroBill?.id, status: 'synced', photoDataUrl });
      App.toast(`${supplier} · $${exGst.toFixed(2)} ex GST sent to Xero`);
      resetForm();
      loadTodayInvoices();
    } catch (err) {
      Store.saveInvoice({ ...invoiceData, status: 'pending', error: err.message });
      App.toast('Saved locally — Xero sync failed', 'warning');
      resetForm();
      loadTodayInvoices();
    } finally {
      if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg> Save &amp; send to Xero'; }
    }
  }

  function resetForm() {
    photoDataUrl = null; photoBlob = null;
    renderForm();
    document.getElementById('invoice-file-input')?.addEventListener('change', handlePhoto);
  }

  // ── Lists ─────────────────────────────────────

  function loadTodayInvoices() {
    const today = new Date().toISOString().slice(0, 10);
    const list = document.getElementById('invoice-list');
    const invoices = Store.getInvoices(today);
    if (!list) return;
    if (!invoices.length) { list.innerHTML = '<div class="empty-state">No invoices entered today</div>'; return; }
    list.innerHTML = '<div class="card">' + invoices.map(inv => `
      <div class="invoice-item">
        <div class="invoice-icon">
          ${inv.photoDataUrl
            ? `<img src="${inv.photoDataUrl}" style="width:36px;height:36px;border-radius:var(--r-sm);object-fit:cover">`
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>`
          }
        </div>
        <div class="invoice-info">
          <div class="invoice-supplier">${escHtml(inv.supplier||'—')}</div>
          <div class="invoice-meta">${inv.invoiceNo||'—'} · ex GST $${(inv.subtotal||0).toFixed(2)}</div>
        </div>
        <div class="invoice-right">
          <div class="invoice-amount">$${(inv.totalIncGst||inv.total||0).toFixed(2)}</div>
          <span class="invoice-status ${inv.status==='synced'?'status-synced':'status-draft'}">
            ${inv.status==='synced'?'In Xero':'Pending'}
          </span>
        </div>
      </div>
    `).join('') + '</div>';
  }

  async function loadPendingXero() {
    const list = document.getElementById('pending-xero-list');
    if (!list) return;
    try {
      const bills = await XeroAPI.getDraftBills();
      const drafts = bills.filter(b => b.status === 'DRAFT').slice(0, 5);
      if (!drafts.length) { list.innerHTML = '<div class="empty-state">No draft bills in Xero</div>'; return; }
      list.innerHTML = '<div class="card">' + drafts.map(b => `
        <div class="invoice-item">
          <div class="invoice-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
          </div>
          <div class="invoice-info">
            <div class="invoice-supplier">${escHtml(b.supplier||'—')}</div>
            <div class="invoice-meta">${b.invoiceNo||'—'} · Due ${b.dueDate?new Date(b.dueDate+'T12:00:00').toLocaleDateString('en-AU',{day:'numeric',month:'short'}):'—'}</div>
          </div>
          <div class="invoice-right">
            <div class="invoice-amount">$${(b.amount||0).toFixed(2)}</div>
            <span class="invoice-status status-draft">Code in Xero</span>
          </div>
        </div>
      `).join('') + '</div>';
    } catch(e) {
      list.innerHTML = '<div class="empty-state">Could not load Xero bills</div>';
    }
  }

  function setEl(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
  function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  return { init, triggerPhoto, triggerLibrary, calcFromTotal, save };

})();
