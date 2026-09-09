// Side panel UI for Wally recording

const statusEl = document.getElementById('status');
const recordBtn = document.getElementById('recordBtn');
const exportBtn = document.getElementById('exportBtn');
const sessionsEl = document.getElementById('sessions');

let recording = false;
let lastSessionId = null;

// Load initial state
chrome.storage.local.get('wally-active-session').then(result => {
  if (result['wally-active-session']) {
    setRecording(true);
  }
});

// Load recent sessions
loadSessions();

// Record/Stop button
recordBtn.addEventListener('click', () => {
  if (recording) {
    chrome.runtime.sendMessage({ type: 'stop_recording' });
    setRecording(false);
  } else {
    chrome.runtime.sendMessage({ type: 'start_recording' });
    setRecording(true);
  }
});

// Export button
exportBtn.addEventListener('click', () => {
  if (lastSessionId) {
    chrome.runtime.sendMessage({ type: 'export_session', id: lastSessionId });
  }
});

function setRecording(isRecording) {
  recording = isRecording;
  if (isRecording) {
    statusEl.textContent = 'Recording...';
    statusEl.className = 'status recording';
    recordBtn.textContent = '⏹ Stop Recording';
    recordBtn.className = 'btn btn-stop';
    exportBtn.disabled = true;
  } else {
    statusEl.textContent = 'Ready to record';
    statusEl.className = 'status idle';
    recordBtn.textContent = '⏺ Start Recording';
    recordBtn.className = 'btn btn-record';
    exportBtn.disabled = false;
    loadSessions();
  }
}

async function loadSessions() {
  const result = await chrome.storage.local.get(null);
  const sessions = Object.keys(result)
    .filter(k => k.startsWith('wally-session-'))
    .map(k => result[k])
    .sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
    .slice(0, 5);

  sessionsEl.innerHTML = sessions.length
    ? '<h3 style="font-size:12px;margin:0 0 8px;color:#666">Recent Sessions</h3>'
    : '';

  for (const session of sessions) {
    const item = document.createElement('div');
    item.className = 'session-item';

    const info = document.createElement('span');
    info.textContent = `${session.id} (${session.actions?.length || 0} actions)`;

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const expBtn = document.createElement('button');
    expBtn.className = 'session-btn export';
    expBtn.textContent = '⬇';
    expBtn.title = 'Export';
    expBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'export_session', id: session.id });
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'session-btn delete';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'delete_session', id: session.id });
      loadSessions();
    });

    actions.appendChild(expBtn);
    actions.appendChild(delBtn);
    item.appendChild(info);
    item.appendChild(actions);
    sessionsEl.appendChild(item);

    // Track last session for export button
    if (!lastSessionId) {
      lastSessionId = session.id;
      exportBtn.disabled = recording;
    }
  }

  // Clear last session if no sessions
  if (!sessions.length) {
    lastSessionId = null;
    exportBtn.disabled = true;
  }
}

// Listen for recording state changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes['wally-active-session']) {
    setRecording(!!changes['wally-active-session'].newValue);
  }
});
