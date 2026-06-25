/**
 * BizOps · Auth Gate
 * PIN-based authentication with staff / manager roles.
 * Session token stored in sessionStorage (cleared on tab close).
 */

const Auth = (() => {

  const TOKEN_KEY  = 'bizops_session_token';
  const EXPIRY_KEY = 'bizops_session_expiry';
  const ROLE_KEY   = 'bizops_session_role';

  function isLoggedIn() {
    if (CONFIG.FEATURES.DEMO_MODE) return true;
    const token  = sessionStorage.getItem(TOKEN_KEY);
    const expiry = parseInt(sessionStorage.getItem(EXPIRY_KEY) || '0');
    return !!token && Date.now() < expiry;
  }

  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  // 'manager' | 'staff' | 'demo'
  function getRole() {
    if (CONFIG.FEATURES.DEMO_MODE) return 'manager'; // full access in demo
    return sessionStorage.getItem(ROLE_KEY) || 'staff';
  }

  function isManager() {
    return getRole() === 'manager';
  }

  async function login(pin) {
    if (CONFIG.FEATURES.DEMO_MODE) return true;
    const res = await fetch(CONFIG.API.AUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'login', pin }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    sessionStorage.setItem(TOKEN_KEY,  data.token);
    sessionStorage.setItem(EXPIRY_KEY, data.expiry);
    sessionStorage.setItem(ROLE_KEY,   data.role || 'staff');
    return true;
  }

  function logout() {
    sessionStorage.clear();
    showLoginScreen();
  }

  function showLoginScreen() {
    document.getElementById('app').style.display = 'none';
    let screen = document.getElementById('login-screen');
    if (!screen) {
      screen = document.createElement('div');
      screen.id = 'login-screen';
      screen.innerHTML = `
        <div style="
          position:fixed;inset:0;background:#0A2A1F;
          display:flex;flex-direction:column;align-items:center;
          justify-content:center;gap:20px;padding:32px;z-index:999;
        ">
          <div style="width:64px;height:64px;background:#1D9E75;border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#fff">B</div>
          <div style="text-align:center">
            <div style="font-size:22px;font-weight:600;color:#fff;margin-bottom:6px">BizOps</div>
            <div style="font-size:14px;color:#9FE1CB">Enter your 4-digit PIN to continue</div>
          </div>
          <div style="display:flex;gap:12px;margin:8px 0" id="pin-dots">
            ${[1,2,3,4].map(i => `<div id="dot-${i}" style="width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,0.2);transition:background 0.15s"></div>`).join('')}
          </div>
          <div id="pin-error" style="color:#F9AAAA;font-size:13px;min-height:18px"></div>
          <div id="pin-keypad" style="display:grid;grid-template-columns:repeat(3,72px);gap:12px">
            ${[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map(k => `
              <button data-key="${k}" style="
                height:72px;border-radius:16px;border:none;
                background:${k===''?'transparent':'rgba(255,255,255,0.08)'};
                color:#fff;font-size:${k==='⌫'?'22px':'24px'};
                font-weight:500;cursor:${k===''?'default':'pointer'};
                transition:background 0.15s;
              " ${k===''?'disabled':''}>
                ${k}
              </button>
            `).join('')}
          </div>
        </div>
      `;
      document.body.appendChild(screen);
      // Attach listeners after DOM insertion (CSP-safe — no inline onclick)
      screen.querySelector('#pin-keypad').addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled) return;
        pinKey(btn.dataset.key);
      });
    }
    screen.style.display = 'block';
  }

  let pinEntry = '';

  function pinKey(key) {
    if (key === '') return;
    if (key === '⌫') {
      pinEntry = pinEntry.slice(0, -1);
    } else if (pinEntry.length < 4) {
      pinEntry += key;
    }
    updateDots();
    if (pinEntry.length === 4) submitPin();
  }

  function updateDots() {
    for (let i = 1; i <= 4; i++) {
      const dot = document.getElementById('dot-' + i);
      if (dot) dot.style.background = i <= pinEntry.length ? '#1D9E75' : 'rgba(255,255,255,0.2)';
    }
  }

  async function submitPin() {
    const ok = await login(pinEntry);
    pinEntry = '';
    updateDots();
    if (ok) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('app').style.display = 'flex';
      // Apply role-based UI after login
      if (window.App && App.applyRoleUI) App.applyRoleUI();
    } else {
      document.getElementById('pin-error').textContent = 'Incorrect PIN — try again';
      setTimeout(() => {
        const el = document.getElementById('pin-error');
        if (el) el.textContent = '';
      }, 2000);
    }
  }

  async function init() {
    if (CONFIG.FEATURES.DEMO_MODE) return;
    if (!isLoggedIn()) {
      document.getElementById('app').style.display = 'none';
      showLoginScreen();
    }
  }

  return { init, isLoggedIn, getToken, getRole, isManager, login, logout, pinKey, showLoginScreen };

})();
