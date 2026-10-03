'use strict';
/* Sober extras: accounts, encrypted cloud backup, slip-ups, trends, exports. */

const API = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
const SESSION_KEY = 'sober-session-v1';
const TRIGGERS = ['Stress', 'Loneliness', 'Boredom', 'Social event', 'Cravings', 'Conflict', 'Tiredness', 'Celebration'];
const MOOD_SCORE = { Great: 4, Okay: 3, Low: 2, Struggling: 1 };
let session = null;
try { session = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) { session = null; }
let passphrase = '';
let syncText = '';
let authMode = 'login';
let pushTimer;

/* ---------- Supabase REST helpers ---------- */
function storeSession(s) {
  session = s;
  try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
}
function toSession(r) {
  if (!r || !r.access_token) return null;
  return { access_token: r.access_token, refresh_token: r.refresh_token, expires_at: Date.now() + (r.expires_in || 3600) * 1000, user: { id: r.user.id, email: r.user.email } };
}
async function api(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  if (auth && session && session.expires_at - Date.now() < 60000) await refreshSession();
  let res;
  try {
    res = await fetch(API + path, {
      method,
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${auth && session ? session.access_token : SUPABASE_ANON_KEY}`, ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (e) {
    throw new Error('Could not reach Supabase. Check your internet connection and the project URL in app.js.');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
  if (!res.ok) throw new Error((data && (data.msg || data.error_description || data.message || data.error)) || `Request failed (${res.status})`);
  return data;
}
async function refreshSession() {
  if (!session || !session.refresh_token) return;
  try {
    const r = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: session.refresh_token }, auth: false });
    storeSession(toSession(r));
  } catch (e) { storeSession(null); passphrase = ''; renderAuthUI(); }
}

/* ---------- Client-side encryption (AES-GCM, key from PBKDF2) ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
const toB64 = buf => { let s = ''; new Uint8Array(buf).forEach(b => { s += String.fromCharCode(b); }); return btoa(s); };
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function deriveKey(pass, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptState() {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(state)));
  return { v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}
async function decryptPayload(p) {
  try {
    const key = await deriveKey(passphrase, fromB64(p.salt));
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(p.iv) }, key, fromB64(p.ct));
    return JSON.parse(dec.decode(plain));
  } catch (e) { throw new Error('That passphrase does not unlock your cloud backup.'); }
}

/* ---------- Sync: merge instead of overwrite so nothing is lost ---------- */
function mergeStates(local, remote) {
  const out = { ...remote, ...local };
  out.checkins = { ...(remote.checkins || {}) };
  for (const [d, c] of Object.entries(local.checkins || {})) {
    const r = out.checkins[d];
    if (!r || (c.updatedAt || '') >= (r.updatedAt || '')) out.checkins[d] = c;
  }
  const union = (a, b) => { const m = new Map(); [...(a || []), ...(b || [])].forEach(x => m.set(x.id, x)); return [...m.values()]; };
  out.journal = union(remote.journal, local.journal);
  out.slips = union(remote.slips, local.slips);
  const newerLocal = (local.updatedAt || '') >= (remote.updatedAt || '');
  out.startDate = (newerLocal ? local.startDate || remote.startDate : remote.startDate || local.startDate) || '';
  out.theme = local.theme;
  return out;
}
function setSync(text) { syncText = text; renderAuthUI(); }
async function pullAndMerge() {
  setSync('Syncing…');
  try {
    const rows = await api(`/rest/v1/sober_vault?select=payload,updated_at&user_id=eq.${session.user.id}`);
    if (rows && rows.length) state = mergeStates(state, await decryptPayload(rows[0].payload));
  } catch (e) { passphrase = ''; setSync('Locked'); throw e; }
  saveState();
  renderAll();
}
async function pushNow() {
  if (!session || !passphrase) return;
  try {
    setSync('Saving…');
    const payload = await encryptState();
    await api('/rest/v1/sober_vault?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: { user_id: session.user.id, payload, updated_at: new Date().toISOString() } });
    setSync('Backed up');
  } catch (e) { setSync('Backup failed'); showToast(e.message); }
}
function queueCloudPush() {
  if (!session || !passphrase) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1500);
}

/* ---------- Auth UI ---------- */
function renderAuthUI() {
  const signedIn = !!session;
  $('#login-btn').hidden = signedIn;
  $('#signup-btn').hidden = signedIn;
  $('#account-btn').hidden = !signedIn;
  if (signedIn) {
    const status = passphrase ? (syncText || 'Backed up') : 'Locked';
    $('#account-btn').textContent = `${session.user.email} · ${status}`;
    $('#account-email').textContent = session.user.email;
    $('#account-status').textContent = passphrase ? `Cloud backup: ${syncText || 'Ready'}.` : 'Enter your encryption passphrase to unlock your cloud backup and keep it in sync.';
    $('#unlock-box').hidden = !!passphrase;
    $('#sync-btn').textContent = passphrase ? 'Back up now' : 'Unlock and sync';
  }
}
function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-signup').classList.toggle('active', mode === 'signup');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#auth-message').textContent = '';
}
function openAuth(mode) {
  const dlg = $('#auth-dialog');
  $('#auth-form').hidden = !!session;
  $('#account-view').hidden = !session;
  if (!session) setAuthMode(mode || 'login');
  renderAuthUI();
  if (!dlg.open) dlg.showModal();
}
async function handleAuth(event) {
  event.preventDefault();
  const email = $('#auth-email').value.trim(), password = $('#auth-password').value, pass = $('#auth-passphrase').value;
  const msg = $('#auth-message'), btn = $('#auth-submit');
  msg.className = 'form-message';
  if (pass.length < 8) { msg.textContent = 'Use an encryption passphrase of at least 8 characters.'; return; }
  if (pass === password) { msg.textContent = 'Your encryption passphrase must be different from your password.'; return; }
  btn.disabled = true; msg.textContent = authMode === 'signup' ? 'Creating your account…' : 'Logging in…';
  try {
    const r = await api(authMode === 'signup' ? '/auth/v1/signup' : '/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, auth: false });
    const s = toSession(r);
    if (!s) {
      setAuthMode('login');
      msg.className = 'form-message ok';
      msg.textContent = 'Account created. Open the confirmation link we emailed you, then log in here.';
      return;
    }
    storeSession(s); passphrase = pass;
    await pullAndMerge();
    $('#auth-form').reset();
    $('#auth-dialog').close();
    showToast('You are signed in. Your encrypted backup is on.');
  } catch (e) {
    msg.textContent = e.message;
    if (session) { $('#auth-dialog').close(); openAuth(); $('#unlock-message').textContent = e.message; }
  } finally { btn.disabled = false; renderAuthUI(); }
}
async function handleUnlock() {
  const msg = $('#unlock-message'); msg.textContent = '';
  try {
    if (!passphrase) {
      const p = $('#unlock-passphrase').value;
      if (p.length < 8) { msg.textContent = 'Enter the passphrase you chose when you signed up.'; return; }
      passphrase = p;
      await pullAndMerge();
      $('#unlock-passphrase').value = '';
      showToast('Unlocked. Your data is in sync.');
    } else { await pushNow(); }
  } catch (e) { msg.textContent = e.message; }
  renderAuthUI();
}
async function handleLogout() {
  try { await api('/auth/v1/logout', { method: 'POST' }); } catch (e) { /* session may already be gone */ }
  storeSession(null); passphrase = ''; syncText = '';
  $('#auth-dialog').close(); renderAuthUI();
  showToast('Logged out. Your data is still saved on this device.');
}

/* ---------- Slip-ups ---------- */
function openSlipDialog() {
  $('#slip-date').value = localISODate(); $('#slip-date').max = localISODate(); $('#slip-note').value = '';
  $('#slip-dialog').showModal();
}
function renderSlips() {
  const slips = [...state.slips].sort((a, b) => b.date.localeCompare(a.date));
  $('#slip-list').innerHTML = slips.length ? slips.map(s => `<div class="entry-row"><div class="entry-main"><strong>${formatDate(s.date)}</strong><p>${escapeHTML(s.note || 'No note added.')}</p></div><button class="delete-entry" data-slip="${escapeHTML(s.id)}" aria-label="Delete slip-up">×</button></div>`).join('')
    : '<p class="muted-text">No slip-ups logged. If one happens, you can record it here without losing your progress.</p>';
}

/* ---------- Trends ---------- */
function lastDays(n) {
  const out = [], today = parseLocalDate(localISODate());
  for (let i = n - 1; i >= 0; i--) { const d = new Date(today); d.setDate(today.getDate() - i); out.push(localISODate(d)); }
  return out;
}
const avg = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
function renderTrends() {
  const days = lastDays(14), W = 640, H = 190, P = 28;
  const x = i => P + i * (W - 2 * P) / (days.length - 1);
  const y = v => H - P - (v - 1) / 4 * (H - 2 * P);
  const series = [
    { name: 'Mood', cls: 'mood', get: c => MOOD_SCORE[c.mood] ? 1 + (MOOD_SCORE[c.mood] - 1) / 3 * 4 : null },
    { name: 'Sleep', cls: 'sleep', get: c => Number(c.sleep) || null },
    { name: 'Stress', cls: 'stress', get: c => Number(c.stress) || null }
  ];
  const hasData = days.some(d => state.checkins[d]);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Mood, sleep and stress over the last 14 days">`;
  for (let v = 1; v <= 5; v++) svg += `<line class="grid" x1="${P}" x2="${W - P}" y1="${y(v)}" y2="${y(v)}"/>`;
  days.forEach((d, i) => { if (state.slips.some(s => s.date === d)) svg += `<line class="slipline" x1="${x(i)}" x2="${x(i)}" y1="${P / 2}" y2="${H - P}"/>`; });
  series.forEach(s => {
    let path = '', pen = false, dots = '';
    days.forEach((d, i) => {
      const c = state.checkins[d], v = c ? s.get(c) : null;
      if (v == null) { pen = false; return; }
      path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; pen = true;
      dots += `<circle class="dot ${s.cls}" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3.5"/>`;
    });
    svg += `<path class="line ${s.cls}" d="${path}"/>${dots}`;
  });
  [0, 6, 13].forEach(i => { svg += `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === 13 ? 'end' : 'middle'}">${formatDate(days[i]).replace(/, \d{4}/, '')}</text>`; });
  svg += '</svg>';
  $('#trend-chart').innerHTML = (hasData ? svg : '<p class="muted-text">Save a few daily check-ins with sleep and stress and your trends will draw themselves here.</p>')
    + '<div class="legend"><span class="mood">Mood</span><span class="sleep">Sleep (1 poor – 5 great)</span><span class="stress">Stress (1 calm – 5 overwhelming)</span><span class="slip">Slip-up</span></div>';

  const all = Object.values(state.checkins), notes = [];
  const poor = all.filter(c => Number(c.sleep) && Number(c.sleep) <= 2 && Number(c.stress)).map(c => Number(c.stress));
  const good = all.filter(c => Number(c.sleep) >= 3 && Number(c.stress)).map(c => Number(c.stress));
  if (poor.length >= 2 && good.length >= 2) {
    const a = avg(poor), b = avg(good);
    if (Math.abs(a - b) >= 0.5) notes.push(`After poor sleep your stress averaged ${a.toFixed(1)}, compared with ${b.toFixed(1)} after better sleep.`);
  }
  const hard = all.filter(c => ['Low', 'Struggling'].includes(c.mood) && Number(c.stress)).map(c => Number(c.stress));
  const okay = all.filter(c => ['Great', 'Okay'].includes(c.mood) && Number(c.stress)).map(c => Number(c.stress));
  if (hard.length >= 2 && okay.length >= 2 && avg(hard) - avg(okay) >= 0.5) notes.push(`Your harder days carry more stress: ${avg(hard).toFixed(1)} on average, versus ${avg(okay).toFixed(1)} on better days.`);
  const counts = {};
  all.forEach(c => (c.triggers || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= 2) notes.push(`${top[0]} is your most frequent trigger, logged on ${top[1]} days. It may be worth planning for.`);
  $('#insights').innerHTML = notes.length ? notes.map(n => `<p>${escapeHTML(n)}</p>`).join('')
    : '<p class="muted-text">Patterns appear after a few days of logging sleep, stress and triggers.</p>';
}

/* ---------- Exports ---------- */
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
const csvCell = v => {
  let s = String(v == null ? '' : v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function buildCSV() {
  const rows = [['date', 'type', 'mood', 'sleep_1to5', 'stress_1to5', 'triggers', 'title', 'text']];
  Object.entries(state.checkins).forEach(([d, c]) => rows.push([d, 'check-in', c.mood, c.sleep, c.stress, (c.triggers || []).join('; '), '', c.note]));
  state.journal.forEach(j => rows.push([j.date, 'journal', '', '', '', '', j.title, j.body]));
  state.slips.forEach(s => rows.push([s.date, 'slip-up', '', '', '', '', '', s.note]));
  rows.sort((a, b) => (a[0] === 'date' ? -1 : b[0] === 'date' ? 1 : b[0].localeCompare(a[0])));
  return rows.map(r => r.map(csvCell).join(',')).join('\n');
}
function buildMarkdown() {
  let md = `# Sober data export\n\nExported ${new Date().toLocaleString()}\n\n- Start date: ${state.startDate || 'not set'}\n- Consecutive days: ${currentStreak()}\n- Total sober days: ${totalSoberDays()}\n- Slip-ups logged: ${state.slips.length}\n\n## Daily check-ins\n\n`;
  Object.entries(state.checkins).sort((a, b) => b[0].localeCompare(a[0])).forEach(([d, c]) => {
    md += `### ${d} — ${c.mood || 'No mood'}\n\n- Sleep: ${c.sleep || 'n/a'}/5\n- Stress: ${c.stress || 'n/a'}/5\n- Triggers: ${(c.triggers || []).join(', ') || 'none'}\n\n${c.note || ''}\n\n`;
  });
  md += '## Journal\n\n';
  [...state.journal].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).forEach(j => { md += `### ${j.date} — ${j.title || 'Untitled'}\n\n${j.body}\n\n`; });
  md += '## Slip-ups\n\n';
  [...state.slips].sort((a, b) => b.date.localeCompare(a.date)).forEach(s => { md += `- ${s.date}: ${s.note || 'no note'}\n`; });
  return md;
}

/* ---------- Render hook (called from renderAll) ---------- */
function renderExtras() {
  $('#total-days').textContent = totalSoberDays();
  const today = state.checkins[localISODate()] || {};
  $('#checkin-sleep').value = today.sleep || '';
  $('#checkin-stress').value = today.stress || '';
  selectedTriggers = [...(today.triggers || [])];
  $('#trigger-chips').innerHTML = TRIGGERS.map(t => `<button type="button" class="chip ${selectedTriggers.includes(t) ? 'selected' : ''}" data-trigger="${t}" aria-pressed="${selectedTriggers.includes(t)}">${t}</button>`).join('');
  const recentSlip = state.slips.some(s => dayDifference(s.date, localISODate()) <= 3);
  $('#support-card').hidden = !(['Low', 'Struggling'].includes(today.mood) || recentSlip);
  renderSlips(); renderTrends(); renderAuthUI();
}

/* ---------- Events ---------- */
$('#login-btn').addEventListener('click', () => openAuth('login'));
$('#signup-btn').addEventListener('click', () => openAuth('signup'));
$('#account-btn').addEventListener('click', () => openAuth());
$('#tab-login').addEventListener('click', () => setAuthMode('login'));
$('#tab-signup').addEventListener('click', () => setAuthMode('signup'));
$('#auth-form').addEventListener('submit', handleAuth);
$('#sync-btn').addEventListener('click', handleUnlock);
$('#logout-btn').addEventListener('click', handleLogout);
$('#slip-button').addEventListener('click', openSlipDialog);
$('#slip-button-2').addEventListener('click', openSlipDialog);
$$('[data-close]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.close).close()));
$('#trigger-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-trigger]');
  if (!b) return;
  const t = b.dataset.trigger;
  selectedTriggers = selectedTriggers.includes(t) ? selectedTriggers.filter(x => x !== t) : [...selectedTriggers, t];
  b.classList.toggle('selected', selectedTriggers.includes(t));
  b.setAttribute('aria-pressed', selectedTriggers.includes(t));
});
$('#slip-form').addEventListener('submit', e => {
  e.preventDefault();
  const date = $('#slip-date').value;
  if (!date || date > localISODate()) { showToast('Choose today or a date in the past.'); return; }
  state.slips.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, date, note: $('#slip-note').value.trim() });
  if (saveState()) {
    $('#slip-dialog').close(); renderAll();
    showToast(`Logged. Your ${totalSoberDays()} total sober days are still yours.`);
  }
});
$('#slip-list').addEventListener('click', e => {
  const b = e.target.closest('[data-slip]');
  if (!b || !confirm('Delete this slip-up entry?')) return;
  state.slips = state.slips.filter(s => s.id !== b.dataset.slip);
  if (saveState()) renderAll();
});
$$('[data-export]').forEach(b => b.addEventListener('click', () => {
  const kind = b.dataset.export, stamp = localISODate();
  if (kind === 'csv') download(`sober-export-${stamp}.csv`, buildCSV(), 'text/csv');
  else if (kind === 'md') download(`sober-export-${stamp}.md`, buildMarkdown(), 'text/markdown');
  else exportData();
  if (kind !== 'json') showToast('Your export has been downloaded.');
}));

/* ---------- Password reset ---------- */
$('#forgot-btn').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim(), msg = $('#auth-message');
  msg.className = 'form-message';
  if (!email) { msg.textContent = 'Enter your email above first.'; return; }
  try {
    await api('/auth/v1/recover', { method: 'POST', body: { email }, auth: false });
    msg.className = 'form-message ok'; msg.textContent = 'If that email has an account, a reset link is on its way.';
  } catch (e) { msg.textContent = e.message; }
});
$('#reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#reset-message');
  try {
    const res = await fetch(API + '/auth/v1/user', { method: 'PUT', headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json', Authorization: `Bearer ${recoveryToken}` }, body: JSON.stringify({ password: $('#reset-password').value }) });
    if (!res.ok) throw new Error((await res.json()).msg || 'Could not update your password.');
    history.replaceState(null, '', location.pathname);
    $('#reset-dialog').close(); showToast('Password updated. Log in with your new password.'); openAuth('login');
  } catch (err) { msg.textContent = err.message; }
});
let recoveryToken = '';
const hashParams = new URLSearchParams(location.hash.slice(1));
if (hashParams.get('type') === 'recovery' && hashParams.get('access_token')) {
  recoveryToken = hashParams.get('access_token');
  $('#reset-dialog').showModal();
}

renderAll();
if (session) refreshSession().then(renderAuthUI);
