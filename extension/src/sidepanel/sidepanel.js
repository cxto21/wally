/**
 * Wally Side Panel — recording UI with URL input and live log
 */

const urlInput = document.getElementById('urlInput');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const recordBtn = document.getElementById('recordBtn');
const stopBtn = document.getElementById('stopBtn');
const exportBtn = document.getElementById('exportBtn');
const logSection = document.getElementById('logSection');
const logEl = document.getElementById('log');
const actionCountEl = document.getElementById('actionCount');
const sessionsEl = document.getElementById('sessions');

let recording = false;
let lastSessionId = null;
let pollTimer = null;
let lastActionCount = 0;

// ═══════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════

// Check if already recording
chrome.runtime.sendMessage({ type: 'get_status' }, (res) => {
  if (res && res.state === 'recording') {
    setRecording(true, res.sessionId);
  }
});

loadSessions();

// ═══════════════════════════════════════════════════════════════
// RECORD / STOP
// ═══════════════════════════════════════════════════════════════

recordBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!url || !url.startsWith('http')) {
    urlInput.style.borderColor = '#ff4444';
    urlInput.focus();
    setTimeout(() => { urlInput.style.borderColor = '#3d3d5c'; }, 2000);
    return;
  }

  // Open URL in new tab and start recording
  chrome.runtime.sendMessage({ type: 'start_recording', url }, (res) => {
    if (res && res.ok) {
      setRecording(true, res.sessionId);
    }
  });
});

stopBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'stop_recording' }, (res) => {
    if (res && res.ok) {
      setRecording(false);
      lastSessionId = res.sessionId;
      actionCountEl.textContent = `${res.actionCount} actions`;
      exportBtn.disabled = false;
      loadSessions();
    }
  });
});

exportBtn.addEventListener('click', () => {
  if (lastSessionId) {
    chrome.runtime.sendMessage({ type: 'export_session', id: lastSessionId }, (res) => {
      if (res && res.ok) {
        exportBtn.textContent = res.exported === 'bridge' ? '✓ Sent to bridge' : '✓ Downloaded';
        setTimeout(() => { exportBtn.textContent = '⬇ Export Session'; }, 2000);
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// UI STATE
// ═══════════════════════════════════════════════════════════════

function setRecording(isRecording, sessionId) {
  recording = isRecording;
  if (isRecording) {
    statusEl.className = 'status recording';
    statusText.textContent = 'Recording...';
    recordBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    exportBtn.disabled = true;
    logSection.style.display = 'block';
    logEl.innerHTML = '';
    lastActionCount = 0;
    actionCountEl.textContent = '0 actions';
    if (sessionId) lastSessionId = sessionId;

    // Start polling for live log
    startLogPoll();
  } else {
    statusEl.className = 'status idle';
    statusText.textContent = 'Ready to record';
    recordBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    logSection.style.display = 'none';
    stopLogPoll();
  }
}

// ═══════════════════════════════════════════════════════════════
// LIVE LOG — poll session actions for display
// ═══════════════════════════════════════════════════════════════

function startLogPoll() {
  stopLogPoll();
  pollTimer = setInterval(pollLog, 800);
}

function stopLogPoll() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function pollLog() {
  if (!lastSessionId) return;

  chrome.storage.local.get(`wally-session-${lastSessionId}`, (data) => {
    const sess = data[`wally-session-${lastSessionId}`];
    if (!sess || !sess.actions) return;

    const actions = sess.actions;
    actionCountEl.textContent = `${actions.length} actions`;

    // Show new entries since last poll
    if (actions.length > lastActionCount) {
      for (let i = lastActionCount; i < actions.length; i++) {
        appendLogEntry(actions[i]);
      }
      lastActionCount = actions.length;
    }
  });
}

function appendLogEntry(action) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';

  const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let detail = '';
  switch (action.type) {
    case 'navigate':
      detail = action.url || '';
      break;
    case 'click':
      detail = action.text ? `"${action.text.substring(0, 40)}"` : action.selector || '';
      break;
    case 'fill':
      detail = `"${(action.value || '').substring(0, 30)}"`;
      break;
    case 'select':
      detail = action.options ? action.options.join(', ') : '';
      break;
    case 'press':
      detail = action.key || '';
      break;
    case 'scroll':
      detail = `y:${action.scrollTop || 0}`;
      break;
    case 'extension_connect':
      detail = action.account ? `${action.provider}:${action.account.substring(0, 10)}...` : '';
      break;
    default:
      detail = action.selector || '';
  }

  entry.innerHTML = `<span class="time">${time}</span> <span class="type">${action.type}</span> <span class="detail">${escapeHtml(detail)}</span>`;

  logEl.appendChild(entry);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════
// SESSIONS LIST
// ═══════════════════════════════════════════════════════════════

function loadSessions() {
  chrome.runtime.sendMessage({ type: 'get_sessions' }, (res) => {
    if (!res || !res.sessions) return;
    renderSessions(res.sessions);
  });
}

function renderSessions(sessions) {
  sessionsEl.innerHTML = '';
  if (sessions.length === 0) return;

  const h3 = document.createElement('h3');
  h3.textContent = 'Recent Sessions';
  sessionsEl.appendChild(h3);

  for (const sess of sessions.slice(0, 5)) {
    const item = document.createElement('div');
    item.className = 'session-item';

    const info = document.createElement('span');
    const date = new Date(sess.startTime).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    info.textContent = `${date} — ${sess.actions?.length || 0} actions`;

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const expBtn = document.createElement('button');
    expBtn.className = 'session-btn export';
    expBtn.textContent = '⬇';
    expBtn.title = 'Export';
    expBtn.addEventListener('click', () => {
      lastSessionId = sess.id;
      exportBtn.disabled = false;
      chrome.runtime.sendMessage({ type: 'export_session', id: sess.id });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'session-btn delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'delete_session', id: sess.id }, () => {
        loadSessions();
      });
    });

    actions.appendChild(expBtn);
    actions.appendChild(delBtn);
    item.appendChild(info);
    item.appendChild(actions);
    sessionsEl.appendChild(item);
  }
}

// ═══════════════════════════════════════════════════════════════
// STORAGE LISTENER — update UI on state changes
// ═══════════════════════════════════════════════════════════════

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['wally-active-session']) {
    const active = changes['wally-active-session'].newValue;
    if (active && !recording) {
      setRecording(true, active);
    } else if (!active && recording) {
      setRecording(false);
    }
  }
});
