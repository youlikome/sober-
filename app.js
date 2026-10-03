'use strict';

const SUPABASE_URL = "https://gqctqdcjdtjrezjaqcbe.supabase.co/rest/v1/";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdxY3RxZGNqZHRqcmV6amFxY2JlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA3NzM0NDIsImV4cCI6MjEwNjM0OTQ0Mn0.pWpp7CcUR2TOvSazYhhNFb417S5ulIbqDKeNNVQxyVM";
const STORAGE_KEY = 'sober-tracker-v1';
const MILESTONES = [1, 3, 7, 14, 30, 60, 90, 180, 365];
const QUOTES = [
  'You don’t have to see the whole staircase. Just take the first step.',
  'You are allowed to grow at your own pace.',
  'A difficult day does not mean a difficult life.',
  'You can begin again, as many times as you need.',
  'Small, steady choices can make a meaningful difference.',
  'Be patient with yourself. You are learning a new way forward.'
];
const MOOD_SYMBOLS = { Great: '☺', Okay: '◡', Low: '⌢', Struggling: '♡' };

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const localISODate = (date = new Date()) => {
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 10);
};
const parseLocalDate = value => {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};
const formatDate = value => {
  const date = parseLocalDate(value);
  return date ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
};
const dayDifference = (from, to) => {
  const a = parseLocalDate(from), b = parseLocalDate(to);
  return a && b ? Math.max(0, Math.floor((b - a) / 86400000)) : 0;
};

function defaultState() {
  return { startDate: '', checkins: {}, journal: [], slips: [], theme: 'light', updatedAt: '' };
}
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved || typeof saved !== 'object') return defaultState();
    return { ...defaultState(), ...saved, checkins: saved.checkins || {}, journal: Array.isArray(saved.journal) ? saved.journal : [], slips: Array.isArray(saved.slips) ? saved.slips : [] };
  } catch (error) {
    console.warn('Could not load saved data:', error);
    return defaultState();
  }
}
let state = loadState();
let selectedMood = '';
let selectedTriggers = [];

function saveState() {
  try {
    state.updatedAt = new Date().toISOString();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (typeof queueCloudPush === 'function') queueCloudPush();
    return true;
  } catch (error) {
    console.error('Could not save data:', error);
    showToast('Could not save. Check your browser storage settings.');
    return false;
  }
}
function lastSlipDate() { return (state.slips || []).map(s => s.date).sort().pop() || ''; }
function currentStreak() {
  if (!state.startDate) return 0;
  const slip = lastSlipDate();
  return dayDifference(slip && slip >= state.startDate ? slip : state.startDate, localISODate());
}
function totalSoberDays() {
  if (!state.startDate) return 0;
  const today = localISODate();
  const slipDays = new Set((state.slips || []).map(s => s.date).filter(d => d >= state.startDate && d <= today)).size;
  return Math.max(0, dayDifference(state.startDate, today) - slipDays);
}
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]);
}
function renderMilestones() {
  const days = currentStreak();
  $('#milestone-grid').innerHTML = MILESTONES.slice(0, 5).map((milestone, index) => {
    const complete = days >= milestone;
    return `<article class="milestone ${complete ? 'complete' : ''}">
      ${complete ? '<span class="milestone-check">✓</span>' : ''}
      <div class="milestone-icon">${['✳', '◈', '✦', '◇', '♧'][index]}</div>
      <strong>${milestone} ${milestone === 1 ? 'day' : 'days'}</strong>
      <small>${complete ? 'Milestone reached' : `${Math.max(0, milestone - days)} days to go`}</small>
    </article>`;
  }).join('');
}
function renderRecent() {
  const entries = [...state.journal].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 3);
  const checkins = Object.entries(state.checkins).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 3);
  const combined = [
    ...entries.map(entry => ({ date: entry.date, title: entry.title || 'Journal reflection', body: entry.body, type: 'Journal' })),
    ...checkins.map(([date, item]) => ({ date, title: `Daily check-in · ${item.mood || 'Reflection'}`, body: item.note || 'Checked in with yourself today.', type: 'Check-in' }))
  ].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4);
  const container = $('#recent-entries');
  if (!combined.length) {
    container.innerHTML = '<div class="empty-state"><span class="empty-icon">▤</span><strong>Your reflections will appear here</strong><p>Save a daily check-in or write a journal entry to get started.</p></div>';
    return;
  }
  container.innerHTML = combined.map(item => `<div class="entry-row"><div class="entry-main"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.body)}</p></div><span class="entry-meta">${formatDate(item.date)}</span></div>`).join('');
}
function renderOverview() {
  const days = currentStreak();
  $('#days-count').textContent = days;
  $('#start-date-label').textContent = state.startDate ? `Journey started ${formatDate(state.startDate)}` : 'Set your start date to begin';
  $('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const today = state.checkins[localISODate()];
  selectedMood = today?.mood || '';
  $('#checkin-note').value = today?.note || '';
  $$('.mood-option').forEach(button => button.classList.toggle('selected', button.dataset.mood === selectedMood));
  $('#checkin-status').textContent = today ? 'Your check-in is saved.' : 'Only you can see this.';
  renderMilestones();
  renderRecent();
}
function renderJournal() {
  $('#journal-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const entries = [...state.journal].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#entry-count').textContent = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;
  $('#journal-list').innerHTML = entries.length ? entries.map(entry => `<article class="panel journal-entry">
    <div class="journal-entry-head"><div><h3>${escapeHTML(entry.title || 'Untitled reflection')}</h3><time>${formatDate(entry.date)}</time></div><button class="delete-entry" data-delete="${escapeHTML(entry.id)}" title="Delete entry" aria-label="Delete ${escapeHTML(entry.title || 'entry')}">×</button></div>
    <p>${escapeHTML(entry.body)}</p></article>`).join('') : '<section class="panel empty-state"><span class="empty-icon">▤</span><strong>No journal entries yet</strong><p>Your reflections will be saved here when you write one.</p></section>';
}
function renderProgress() {
  const days = currentStreak();
  const checkinCount = Object.keys(state.checkins).length;
  const completed = MILESTONES.filter(m => days >= m).length;
  const money = Number(state.moneySaved || 0);
  $('#progress-stats').innerHTML = `<div class="stat-card"><div class="stat-label">Consecutive days</div><div class="stat-value">${days} <span style="font-size:12px;font-weight:500;letter-spacing:0">days</span></div><div class="stat-note">Since your last slip-up or start date</div></div>
    <div class="stat-card"><div class="stat-label">Total sober days</div><div class="stat-value">${totalSoberDays()}</div><div class="stat-note">A slip-up never erases these</div></div>
    <div class="stat-card"><div class="stat-label">Check-ins logged</div><div class="stat-value">${checkinCount}</div><div class="stat-note">Moments of self-reflection</div></div>
    <div class="stat-card"><div class="stat-label">Milestones reached</div><div class="stat-value">${completed}</div><div class="stat-note">Of ${MILESTONES.length} milestones</div></div>`;
  const today = parseLocalDate(localISODate());
  const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const week = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(today.getDate() - i);
    const iso = localISODate(date);
    week.push({ iso, label: daysOfWeek[date.getDay()], has: !!state.checkins[iso] });
  }
  $('#mood-chart').innerHTML = week.map(day => `<div class="chart-day"><div class="chart-bar-wrap"><div class="chart-bar ${day.has ? 'has-entry' : ''}" style="height:${day.has ? '100%' : '5px'}" title="${day.has ? 'Check-in saved' : 'No check-in'}"></div></div><span>${day.label}</span></div>`).join('');
  $('#timeline-list').innerHTML = MILESTONES.map(milestone => {
    const done = days >= milestone;
    return `<div class="timeline-item ${done ? '' : 'pending'}"><div class="timeline-icon">${done ? '✓' : '·'}</div><div class="timeline-copy"><strong>${milestone} ${milestone === 1 ? 'day' : 'days'} sober</strong><small>${done ? 'A milestone in your journey' : 'Keep taking it one day at a time'}</small></div><span class="timeline-status">${done ? 'Reached' : 'Upcoming'}</span></div>`;
  }).join('');
}
function renderAll() {
  document.body.classList.toggle('dark', state.theme === 'dark');
  $('#theme-icon').textContent = state.theme === 'dark' ? '☼' : '◐';
  renderOverview();
  renderJournal();
  renderProgress();
  if (typeof renderExtras === 'function') renderExtras();
}
function navigate(view) {
  $$('.view').forEach(section => section.classList.toggle('active', section.id === `${view}-view`));
  $$('.nav-link[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === view));
  const labels = { overview: 'Overview', journal: 'My journal', progress: 'Progress' };
  $('#page-label').textContent = labels[view] || 'Overview';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function openDateDialog() {
  $('#sobriety-date').value = state.startDate || localISODate();
  $('#date-dialog').showModal();
}
function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'Sober', version: 1, exportedAt: new Date().toISOString(), data: state }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sober-backup-${localISODate()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Your data backup has been exported.');
}

$$('.nav-link[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
$$('[data-open]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.open)));
$('#theme-toggle').addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  saveState(); renderAll();
});
$('#export-button').addEventListener('click', exportData);
$('#edit-date-button').addEventListener('click', openDateDialog);
$('#progress-edit-date').addEventListener('click', openDateDialog);
$('#date-form').addEventListener('submit', event => {
  event.preventDefault();
  const chosen = $('#sobriety-date').value;
  if (!chosen) return;
  if (chosen > localISODate()) { showToast('Choose today or a date in the past.'); return; }
  state.startDate = chosen;
  if (saveState()) {
    $('#date-dialog').close();
    renderAll();
    showToast('Your start date has been updated.');
  }
});
$('#date-dialog').addEventListener('click', event => {
  if (event.target === $('#date-dialog')) $('#date-dialog').close();
});
$('#mood-options').addEventListener('click', event => {
  const button = event.target.closest('[data-mood]');
  if (!button) return;
  selectedMood = button.dataset.mood;
  $$('.mood-option').forEach(option => option.classList.toggle('selected', option === button));
});
$('#save-checkin').addEventListener('click', () => {
  if (!selectedMood) { showToast('Choose how you are feeling first.'); return; }
  const today = localISODate();
  state.checkins[today] = { mood: selectedMood, note: $('#checkin-note').value.trim(), sleep: $('#checkin-sleep').value, stress: $('#checkin-stress').value, triggers: [...selectedTriggers], updatedAt: new Date().toISOString() };
  if (saveState()) { renderAll(); showToast('Check-in saved. Thank you for checking in.'); }
});
$('#save-journal').addEventListener('click', () => {
  const body = $('#journal-body').value.trim();
  if (!body) { showToast('Write a reflection before saving.'); $('#journal-body').focus(); return; }
  state.journal.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, title: $('#journal-title').value.trim(), body, date: localISODate(), createdAt: new Date().toISOString() });
  if (saveState()) {
    $('#journal-title').value = ''; $('#journal-body').value = '';
    renderAll(); showToast('Your reflection has been saved.');
  }
});
$('#journal-list').addEventListener('click', event => {
  const button = event.target.closest('[data-delete]');
  if (!button) return;
  if (!confirm('Delete this journal entry? This cannot be undone.')) return;
  state.journal = state.journal.filter(entry => entry.id !== button.dataset.delete);
  if (saveState()) { renderAll(); showToast('Entry deleted.'); }
});
$('#new-quote').addEventListener('click', () => {
  const current = $('#daily-quote').textContent;
  const choices = QUOTES.filter(quote => quote !== current);
  $('#daily-quote').textContent = choices[Math.floor(Math.random() * choices.length)];
});
$('#today-label').textContent = new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
$('#sobriety-date').max = localISODate();
renderAll();
