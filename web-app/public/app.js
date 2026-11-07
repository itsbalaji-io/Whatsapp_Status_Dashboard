// WhatsApp Status Enterprise Web Hub - Client Application

// ==================== AUTH FETCH WRAPPER ====================
// Ensure all /api/ fetch calls send session cookies
const _originalFetch = window.fetch;
window.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (typeof url === 'string' && url.startsWith('/api/')) {
    init.credentials = 'include';
  }
  return _originalFetch(input, init);
};

// ==================== AUTH STATE ====================
let currentUser = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      currentUser = data.user;
      return true;
    }
  } catch (e) {
    // ignore
  }
  currentUser = null;
  return false;
}

function requireAuth() {
  if (!currentUser) {
    window.location.href = '/login';
  }
}

// MARK: - State
const state = {
  sessions: [],
  historyItems: [],
  historyStats: { total: 0, passed: 0, revoked: 0, failed: 0, scheduled: 0 },
  liveStatuses: [],
  selectedFile: null,
  selectedFilePreviewUrl: null,
  selectedSessionIds: new Set(),
  duplicateSessionIds: new Set(),
  historyDuplicateSessionIds: new Set(),
  phoneDuplicateMatches: {}, // sessionId -> cleanSummary
  searchQueryTargets: '',
  searchQuerySessions: '',
  searchQueryHistory: '',
  searchQueryLive: '',
  historyFilter: 'all',
  isScheduledMode: false,
  liveViewMode: 'account', // 'account' (Group by Account) or 'grid' (All Stories)
  composerMediaUrl: null,
  activeQrPolling: null,
  activeQrSessionId: null,
  autoRefreshLiveTimer: null,
  autoRefreshSessionsTimer: null,
  scheduledItems: []
};

// MARK: - Helpers

function extractRouteFingerprint(text) {
  if (!text) return '';
  const routes = [];
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const clean = rawLine.replace(/\*/g, '').trim();
    if (clean.includes('→') || clean.includes('->')) {
      const normalizedArrow = clean.replace(/->/g, '→');
      const parts = normalizedArrow.split('→');
      if (parts.length >= 2) {
        const origRaw = parts[0];
        let destRaw = parts[1].split('·')[0].split('•')[0].split('-')[0];

        const orig = origRaw.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const dest = destRaw.toLowerCase().replace(/[^a-z\s]/g, '').trim();

        if (orig && dest) {
          routes.push(`${orig}->${dest}`);
        }
      }
    }
  }

  if (routes.length > 0) {
    const uniqueSorted = Array.from(new Set(routes)).sort();
    return uniqueSorted.join('|');
  }

  const filtered = text.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (filtered.length >= 20) {
    return filtered.slice(0, 80);
  }
  return filtered;
}

function extractRouteDisplayList(text) {
  if (!text) return [];
  const routes = [];
  for (const rawLine of text.split('\n')) {
    const clean = rawLine.replace(/\*/g, '').trim();
    if (clean.includes('→') || clean.includes('->')) {
      const shortRoute = (clean.split('·')[0] || clean).trim();
      routes.push(shortRoute);
    }
  }
  return routes;
}

function formatPhone(phone) {
  if (!phone) return '';
  return phone.startsWith('+') ? phone : `+${phone}`;
}

function formatTimestamp(isoStr) {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  const now = new Date();
  const diffHours = (now - date) / (1000 * 3600);

  if (diffHours < 24 && date.getDate() === now.getDate()) {
    return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (diffHours < 48) {
    return `Yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatCountdown(scheduledForIso) {
  if (!scheduledForIso) return '';
  const diff = new Date(scheduledForIso).getTime() - Date.now();
  if (diff <= 0) return 'Executing shortly...';
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `Due in ${days}d ${hours % 24}h`;
  if (hours > 0) return `Due in ${hours}h ${minutes % 60}m`;
  return `Due in ${minutes}m`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <span>${message}</span>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// MARK: - Initializer & Tab Routing
document.addEventListener('DOMContentLoaded', async () => {
  // Global error handler: surface JS errors as toasts so they are visible
  window.addEventListener('error', (e) => {
    console.error('JS Error:', e.message, e.filename, e.lineno);
  });

  const authenticated = await checkAuth();
  if (!authenticated) {
    window.location.href = '/login';
    return;
  }

  setupTabs();
  setupComposer();
  setupSessions();
  setupHistory();
  setupLiveStatuses();
  setupModals();
  setupThemeToggle();
  setupExportHistory();
  setupAuthUI();

  // Initial load
  refreshAllData();
  checkOpenWAConnection();

  // Gateway check every 20 seconds
  setInterval(checkGatewayHealth, 20000);

  // OpenWA connection check every 30 seconds
  setInterval(checkOpenWAConnection, 30000);

  // Session auto-refresh every 30 seconds
  state.autoRefreshSessionsTimer = setInterval(fetchSessions, 30000);
});

function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  document.getElementById('headerGatewayBadge').addEventListener('click', () => {
    switchTab('tab-sessions');
  });

  document.getElementById('btnRefreshAll').addEventListener('click', () => {
    refreshAllData(true);
  });
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === tabId);
  });

  if (tabId === 'tab-live') {
    fetchLiveStatuses();
  } else if (tabId === 'tab-sessions') {
    fetchSessions();
  } else if (tabId === 'tab-history') {
    fetchHistory();
    fetchScheduled();
  }
}

async function refreshAllData(showNotification = false) {
  const refreshBtn = document.getElementById('btnRefreshAll');
  if (refreshBtn) refreshBtn.textContent = '🔄 Refreshing...';

  // Use Promise.allSettled so one failing endpoint does not block the others.
  // Sessions (target accounts) must always load even if history/live-statuses fail.
  await Promise.allSettled([
    checkGatewayHealth(),
    fetchSessions(),
    fetchHistory(),
    fetchLiveStatuses(),
    fetchScheduled()
  ]);

  if (refreshBtn) refreshBtn.textContent = '🔄 Refresh';
  if (showNotification) showToast('All data refreshed!', 'success');
}

// MARK: - Gateway Health
async function checkGatewayHealth() {
  const dot = document.getElementById('headerGatewayDot');
  const text = document.getElementById('headerGatewayText');

  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.gateway === 'online') {
      dot.className = 'status-dot';
      text.textContent = `🟢 ${data.readySessions} of ${data.totalSessions} Accounts Ready`;
    } else {
      dot.className = 'status-dot offline';
      text.textContent = `🔴 Gateway Offline (${data.message || 'Error'})`;
    }
  } catch (err) {
    dot.className = 'status-dot offline';
    text.textContent = '🔴 OpenWA Gateway Disconnected';
  }
}

// MARK: - OpenWA Connection Diagnostic
async function checkOpenWAConnection() {
  const banner = document.getElementById('gatewayBanner');
  const icon = document.getElementById('gatewayBannerIcon');
  const message = document.getElementById('gatewayBannerMessage');
  const detail = document.getElementById('gatewayBannerDetail');

  async function tryEndpoint(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    return await res.json();
  }

  try {
    // Primary diagnostic endpoint; fall back to /api/health if it ever returns non-JSON.
    let data;
    try {
      data = await tryEndpoint('/api/openwa-test');
    } catch (err) {
      data = await tryEndpoint('/api/health');
    }

    if (data.ok || data.gateway === 'online') {
      banner.style.display = 'none';
      return;
    }

    // Build diagnostic message
    const tests = data.tests || {};
    let msg = 'OpenWA Gateway Offline';
    let hint = '';

    if (!tests.baseUrl?.reachable && data.gateway !== 'online') {
      msg = 'Cannot reach OpenWA Gateway';
      hint = tests.baseUrl?.code === 'ECONNREFUSED'
        ? 'OpenWA API is not running on the server. Start it: cd OpenWA && PORT=2785 BIND_HOST=127.0.0.1 npm run start'
        : tests.baseUrl?.message || 'Check network connectivity';
    } else if ((!tests.sessions?.reachable || data.readySessions === 0) && data.gateway !== 'online') {
      msg = 'OpenWA Gateway reachable but sessions endpoint failed';
      hint = tests.sessions?.message || 'Check OpenWA logs for errors';
    }

    icon.textContent = '🔴';
    message.textContent = msg;
    detail.textContent = hint;
    detail.style.display = hint ? 'block' : 'none';
    banner.style.display = 'block';
  } catch (err) {
    icon.textContent = '🔴';
    message.textContent = 'OpenWA Gateway Disconnected';
    detail.textContent = err.message;
    detail.style.display = 'block';
    banner.style.display = 'block';
  }
}

window.testOpenWAConnection = checkOpenWAConnection;

// MARK: - Tab 1: Composer & Post
function setupComposer() {
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const captionInput = document.getElementById('captionInput');
  const charCountLabel = document.getElementById('charCountLabel');
  const btnRemoveFile = document.getElementById('btnRemoveFile');
  const btnModeNow = document.getElementById('btnModeNow');
  const btnModeSchedule = document.getElementById('btnModeSchedule');
  const schedulePickerWrap = document.getElementById('schedulePickerWrap');
  const scheduleDateTimeInput = document.getElementById('scheduleDateTimeInput');
  const btnPushStatus = document.getElementById('btnPushStatus');
  const targetSearchInput = document.getElementById('targetSearchInput');
  const btnToggleSelectAll = document.getElementById('btnToggleSelectAll');
  const btnRefreshTargets = document.getElementById('btnRefreshTargets');

  // Drag and drop events
  dropZone.addEventListener('click', (e) => {
    if (e.target !== btnRemoveFile) fileInput.click();
  });

  ['dragenter', 'dragover'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(name => {
    dropZone.addEventListener(name, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
  });

  dropZone.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) handleSelectedMedia(files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) handleSelectedMedia(fileInput.files[0]);
  });

  btnRemoveFile.addEventListener('click', (e) => {
    e.stopPropagation();
    clearSelectedMedia();
  });

  // Caption input & Character Count
  captionInput.addEventListener('input', () => {
    const len = captionInput.value.length;
    charCountLabel.textContent = `${len} / 700`;
    updateRoutePreview(captionInput.value);
    updateDuplicateState();
    updatePushActionState();
  });

  // Schedule mode toggle
  btnModeNow.addEventListener('click', () => {
    state.isScheduledMode = false;
    btnModeNow.classList.add('active');
    btnModeSchedule.classList.remove('active');
    schedulePickerWrap.style.display = 'none';
    btnPushStatus.classList.remove('scheduled-mode');
    updatePushActionState();
  });

  btnModeSchedule.addEventListener('click', () => {
    state.isScheduledMode = true;
    btnModeSchedule.classList.add('active');
    btnModeNow.classList.remove('active');
    schedulePickerWrap.style.display = 'flex';
    btnPushStatus.classList.add('scheduled-mode');

    // Default scheduled time to 1 hour from now
    if (!scheduleDateTimeInput.value) {
      const d = new Date(Date.now() + 3600000);
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      scheduleDateTimeInput.value = d.toISOString().slice(0, 16);
    }
    updatePushActionState();
  });

  // Target accounts search & select-all
  targetSearchInput.addEventListener('input', (e) => {
    state.searchQueryTargets = e.target.value.toLowerCase().trim();
    renderTargetAccountsList();
  });

  btnToggleSelectAll.addEventListener('click', () => {
    const readySessions = state.sessions.filter(s => s.status.toLowerCase() === 'ready');
    const filteredReady = state.searchQueryTargets
      ? readySessions.filter(s =>
          s.name.toLowerCase().includes(state.searchQueryTargets) ||
          (s.phone && s.phone.includes(state.searchQueryTargets)) ||
          (s.pushName && s.pushName.toLowerCase().includes(state.searchQueryTargets))
        )
      : readySessions;

    const allSelected = filteredReady.length > 0 && filteredReady.every(s => state.selectedSessionIds.has(s.id));
    if (allSelected) {
      filteredReady.forEach(s => state.selectedSessionIds.delete(s.id));
    } else {
      filteredReady.forEach(s => state.selectedSessionIds.add(s.id));
    }
    renderTargetAccountsList();
    updatePushActionState();
  });

  btnRefreshTargets.addEventListener('click', async () => {
    btnRefreshTargets.textContent = '🔄';
    await refreshAllData(true);
    btnRefreshTargets.textContent = '🔄';
  });

  // Broadcast Push Button
  btnPushStatus.addEventListener('click', executeBroadcast);

  // Quick Drip Slot Buttons (9:00 AM, 2:30 PM, 7:00 PM)
  document.querySelectorAll('.btn-drip-slot').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-drip-slot').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const timeStr = btn.getAttribute('data-time') || '09:00';
      state.selectedDripSlot = timeStr;

      const [h, m] = timeStr.split(':').map(Number);
      const target = new Date();
      target.setHours(h, m, 0, 0);
      if (target.getTime() <= Date.now()) {
        target.setDate(target.getDate() + 1);
      }
      const localIso = new Date(target.getTime() - target.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      const scheduleInput = document.getElementById('scheduleDateTimeInput');
      if (scheduleInput) scheduleInput.value = localIso;
      updatePushActionState();
    });
  });

  // Auto-Expire / Flash Sale select listener
  const autoExpireSelect = document.getElementById('autoExpireSelect');
  const autoExpireBadge = document.getElementById('autoExpireBadge');
  if (autoExpireSelect && autoExpireBadge) {
    autoExpireSelect.addEventListener('change', () => {
      const val = autoExpireSelect.value;
      if (val !== '0') {
        autoExpireBadge.style.display = 'inline-block';
        autoExpireBadge.textContent = `⚡ Flash: ${val}h`;
      } else {
        autoExpireBadge.style.display = 'none';
      }
    });
  }

  // Close Viewers Modal button
  document.getElementById('btnCloseViewersModal')?.addEventListener('click', closeViewersModal);
}

function handleSelectedMedia(file) {
  state.selectedFile = file;
  const isVideo = file.type.startsWith('video/') || file.name.endsWith('.mp4') || file.name.endsWith('.mov');

  const dropZonePrompt = document.getElementById('dropZonePrompt');
  const dropZonePreview = document.getElementById('dropZonePreview');
  const previewImg = document.getElementById('previewImg');
  const previewVideo = document.getElementById('previewVideo');
  const previewFileName = document.getElementById('previewFileName');
  const previewFileSize = document.getElementById('previewFileSize');

  previewFileName.textContent = file.name;
  previewFileSize.textContent = (file.size / (1024 * 1024)).toFixed(2) + ' MB';

  const reader = new FileReader();
  reader.onload = (e) => {
    state.selectedFilePreviewUrl = e.target.result;
    if (isVideo) {
      previewImg.style.display = 'none';
      previewVideo.style.display = 'block';
      previewVideo.src = e.target.result;
    } else {
      previewVideo.style.display = 'none';
      previewImg.style.display = 'block';
      previewImg.src = e.target.result;
    }
    dropZonePrompt.style.display = 'none';
    dropZonePreview.style.display = 'flex';
    updateDuplicateState();
    updatePushActionState();
  };
  reader.readAsDataURL(file);
}

function clearSelectedMedia() {
  state.selectedFile = null;
  state.selectedFilePreviewUrl = null;
  state.composerMediaUrl = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('dropZonePrompt').style.display = 'block';
  document.getElementById('dropZonePreview').style.display = 'none';
  document.getElementById('previewImg').src = '';
  document.getElementById('previewVideo').src = '';
  updateDuplicateState();
  updatePushActionState();
}

function updateRoutePreview(caption) {
  const routeBox = document.getElementById('routePreviewBox');
  const chipsContainer = document.getElementById('routeChipsContainer');
  const routes = extractRouteDisplayList(caption);

  if (routes.length > 0) {
    routeBox.style.display = 'flex';
    chipsContainer.innerHTML = routes.map(r => `<span class="route-chip">${r}</span>`).join('');
  } else {
    routeBox.style.display = 'none';
    chipsContainer.innerHTML = '';
  }
}

function updateDuplicateState() {
  // 1. History Duplicate Detection by file name (within 24h, not revoked)
  // Informational only: a past "passed" entry doesn't mean the status is still live on WhatsApp.
  state.historyDuplicateSessionIds.clear();

  if (state.selectedFile && state.historyItems.length > 0) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const cleanFileName = state.selectedFile.name.trim().toLowerCase();

    for (const item of state.historyItems) {
      const itemTs = new Date(item.createdAt).getTime();
      if (itemTs < cutoff || item.status === 'revoked') continue;
      if ((item.fileName || '').trim().toLowerCase() !== cleanFileName) continue;

      if (item.status === 'scheduled' && item.targetSessionIds) {
        item.targetSessionIds.forEach(id => state.historyDuplicateSessionIds.add(id));
      } else if (item.sessionResults) {
        item.sessionResults.forEach(sr => {
          if (sr.status === 'passed' && !sr.revokedAt && sr.sessionId) {
            state.historyDuplicateSessionIds.add(sr.sessionId);
          }
        });
      }
    }
  }

  // 2. Phone Live Duplicate Detection by Route Fingerprint matching active stories from WhatsApp
  // This is the authoritative block: a status actually live on WhatsApp must not be re-posted.
  state.phoneDuplicateMatches = {};

  const caption = document.getElementById('captionInput').value.trim();
  if (caption && state.liveStatuses.length > 0) {
    const currentFingerprint = extractRouteFingerprint(caption);
    if (currentFingerprint) {
      for (const st of state.liveStatuses) {
        if (st.duplicateKey === currentFingerprint) {
          state.phoneDuplicateMatches[st.sessionId] = st.cleanSummary || 'Live Campaign';
        }
      }
    }
  }

  // Combined set used for display badges only (history + live)
  state.duplicateSessionIds = new Set([
    ...state.historyDuplicateSessionIds,
    ...Object.keys(state.phoneDuplicateMatches)
  ]);
}

function renderTargetAccountsList() {
  const container = document.getElementById('targetAccountsList');
  const countLabel = document.getElementById('targetSelectedCountLabel');
  const btnToggleSelectAll = document.getElementById('btnToggleSelectAll');

  if (state.sessions.length === 0) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">No accounts found. Create a session in Sessions tab.</div>`;
    countLabel.textContent = '(0 accounts)';
    return;
  }

  const query = state.searchQueryTargets;
  const filtered = state.sessions.filter(s => {
    if (!query) return true;
    return (
      s.name.toLowerCase().includes(query) ||
      (s.phone && s.phone.includes(query)) ||
      (s.pushName && s.pushName.toLowerCase().includes(query))
    );
  });

  const readySessions = state.sessions.filter(s => s.status.toLowerCase() === 'ready');
  const selectedReadyCount = readySessions.filter(s => state.selectedSessionIds.has(s.id)).length;
  const liveDupIds = new Set(Object.keys(state.phoneDuplicateMatches));
  const selectedLiveDups = [...state.selectedSessionIds].filter(id => liveDupIds.has(id));
  const eligibleSelected = Math.max(0, selectedReadyCount - selectedLiveDups.length);

  if (selectedLiveDups.length > 0) {
    countLabel.textContent = `(${eligibleSelected} ready + ${selectedLiveDups.length} live skipped)`;
  } else {
    countLabel.textContent = `(${selectedReadyCount} of ${readySessions.length} ready selected)`;
  }

  const filteredReady = filtered.filter(s => s.status.toLowerCase() === 'ready');
  const allFilteredSelected = filteredReady.length > 0 && filteredReady.every(s => state.selectedSessionIds.has(s.id));
  btnToggleSelectAll.textContent = allFilteredSelected ? 'Deselect All' : 'Select All';

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">No accounts match "${query}"</div>`;
    return;
  }

  try {
    container.innerHTML = `${filtered.map(s => {
      const isReady = s.status.toLowerCase() === 'ready';
      const isSelected = state.selectedSessionIds.has(s.id);
      const isPhoneDup = Boolean(state.phoneDuplicateMatches[s.id]);
      const isHistoryDup = state.historyDuplicateSessionIds.has(s.id);
      const isDup = isPhoneDup || isHistoryDup;

      let rowClass = 'account-row';
      if (!isReady) rowClass += ' disabled';
      else if (isDup) rowClass += ' duplicate';
      else if (isSelected) rowClass += ' selected';

      let badgeText = 'READY';
      let badgeClass = 'badge badge-ready';
      if (isPhoneDup) {
        badgeText = 'PHONE LIVE';
        badgeClass = 'badge badge-phone-live';
      } else if (isHistoryDup) {
        badgeText = 'POSTED BEFORE';
        badgeClass = 'badge badge-history-dup';
      } else if (!isReady) {
        badgeText = s.status.toUpperCase();
        badgeClass = 'badge badge-offline';
      }

      const dot = isDup ? '🟠' : (isReady ? '🟢' : '🔴');
      const dispName = s.pushName ? `${s.pushName}` : s.name;
      const phoneDisplay = s.phone ? formatPhone(s.phone) : 'No phone';

      const tooltip = isPhoneDup
        ? `⚠️ DUPLICATE: Already posted '${state.phoneDuplicateMatches[s.id]}' from phone. Will be automatically skipped.`
        : isHistoryDup
        ? `⚠️ This file was posted to this account within the last 24h. It may not be live on WhatsApp. Posting again will create a duplicate story.`
        : '';

      return `
        <div class="${rowClass}" data-id="${s.id}" title="${tooltip}">
          <div class="account-info-group">
            <input type="checkbox" class="account-checkbox" data-id="${s.id}" ${isSelected ? 'checked' : ''} ${!isReady ? 'disabled' : ''} />
            <span style="font-size: var(--font-size-base);">${dot}</span>
            <div class="account-name-group">
              <div class="account-name">${dispName}</div>
              <div class="account-phone">${phoneDisplay}</div>
            </div>
          </div>
          <span class="${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join('')}`;
  } catch (err) {
    console.error('renderTargetAccountsList error:', err);
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--accent-red);">Error rendering accounts: ${err.message}</div>`;
  }

  // Attach click listeners to rows & checkboxes
  container.querySelectorAll('.account-row').forEach(row => {
    row.addEventListener('click', (e) => {
      const id = row.getAttribute('data-id');
      const session = state.sessions.find(s => s.id === id);
      if (!session || session.status.toLowerCase() !== 'ready') return;

      if (e.target.tagName !== 'INPUT') {
        if (state.selectedSessionIds.has(id)) {
          state.selectedSessionIds.delete(id);
        } else {
          state.selectedSessionIds.add(id);
        }
      } else {
        if (e.target.checked) state.selectedSessionIds.add(id);
        else state.selectedSessionIds.delete(id);
      }
      renderTargetAccountsList();
      updatePushActionState();
    });
  });
}

function updatePushActionState() {
  const btn = document.getElementById('btnPushStatus');
  const feedback = document.getElementById('pushFeedbackMsg');
  const hasFile = Boolean(state.selectedFile || state.composerMediaUrl);
  const selectedCount = state.selectedSessionIds.size;
  const isScheduled = state.isScheduledMode;

  if (!hasFile) {
    btn.disabled = true;
    btn.textContent = isScheduled ? '⏰ Schedule WhatsApp Status' : '🚀 Push Status to Accounts';
    feedback.textContent = 'Upload or drag-and-drop an image or video to begin.';
    feedback.className = 'push-feedback-msg info';
    return;
  }

  // Blocking only on actual live statuses (authoritative). History-based "passed"
  // entries don't mean the status is still live on WhatsApp, so they must not block.
  const liveDupIds = new Set(Object.keys(state.phoneDuplicateMatches));
  const selectedIds = [...state.selectedSessionIds];
  const eligibleIds = selectedIds.filter(id => !liveDupIds.has(id));
  const liveDuplicateIds = selectedIds.filter(id => liveDupIds.has(id));
  const historyDuplicateIds = selectedIds.filter(id => state.historyDuplicateSessionIds.has(id) && !liveDupIds.has(id));

  if (selectedCount === 0) {
    btn.disabled = true;
    btn.textContent = isScheduled ? '⏰ Schedule WhatsApp Status' : '🚀 Push Status to Accounts';
    feedback.textContent = '⚠️ Select at least 1 ready WhatsApp account.';
    feedback.className = 'push-feedback-msg warning';
    return;
  }

  // All selected accounts already have this status live on WhatsApp — hard block
  if (eligibleIds.length === 0 && liveDuplicateIds.length > 0) {
    btn.disabled = true;
    btn.textContent = `🚫 Already Live on Selected Account${liveDuplicateIds.length === 1 ? '' : 's'}`;
    feedback.textContent = `⚠️ Duplicate Blocked: This status flyer or route is already live on the selected account(s). Choose other accounts or remove the existing status first.`;
    feedback.className = 'push-feedback-msg warning';
    return;
  }

  // Eligible accounts ready for push
  btn.disabled = eligibleIds.length === 0;

  const totalDupCount = liveDuplicateIds.length + historyDuplicateIds.length;
  if (isScheduled) {
    btn.textContent = totalDupCount > 0
      ? `⏰ Schedule for ${eligibleIds.length} New Account${eligibleIds.length === 1 ? '' : 's'}`
      : `⏰ Schedule for ${eligibleIds.length} Account${eligibleIds.length === 1 ? '' : 's'}`;
  } else {
    btn.textContent = totalDupCount > 0
      ? `🚀 Push to ${eligibleIds.length} New Account${eligibleIds.length === 1 ? '' : 's'}`
      : `🚀 Push Status to ${eligibleIds.length} Account${eligibleIds.length === 1 ? '' : 's'}`;
  }

  const infoParts = [];
  if (liveDuplicateIds.length > 0) {
    infoParts.push(`${liveDuplicateIds.length} account${liveDuplicateIds.length === 1 ? '' : 's'} already live (will be skipped)`);
  }
  if (historyDuplicateIds.length > 0) {
    infoParts.push(`${historyDuplicateIds.length} account${historyDuplicateIds.length === 1 ? '' : 's'} posted before (within 24h)`);
  }

  if (infoParts.length > 0) {
    feedback.textContent = `ℹ️ Will broadcast to ${eligibleIds.length} accounts. (${infoParts.join('; ')}).`;
    feedback.className = 'push-feedback-msg info';
  } else {
    feedback.textContent = '';
    feedback.className = 'push-feedback-msg';
  }
}

// Broadcast Execution with Live Session-by-Session Modal
async function executeBroadcast() {
  if (!state.selectedFile && !state.composerMediaUrl) return;

  const liveDupIds = new Set(Object.keys(state.phoneDuplicateMatches));
  const eligibleIds = [...state.selectedSessionIds].filter(id => !liveDupIds.has(id));
  if (eligibleIds.length === 0) return;

  const caption = document.getElementById('captionInput').value.trim();
  const isScheduled = state.isScheduledMode;
  const scheduledFor = isScheduled ? document.getElementById('scheduleDateTimeInput').value : null;

  // Open progress modal
  const modal = document.getElementById('broadcastProgressModal');
  const title = document.getElementById('broadcastModalTitle');
  const counter = document.getElementById('broadcastProgressCounter');
  const bar = document.getElementById('broadcastProgressBar');
  const list = document.getElementById('broadcastProgressList');
  const doneBtn = document.getElementById('btnCloseBroadcastModal');
  const overall = document.getElementById('broadcastOverallStatus');

  title.textContent = isScheduled ? 'Scheduling Status...' : `Broadcasting to ${eligibleIds.length} Accounts...`;
  counter.textContent = `0 / ${eligibleIds.length}`;
  bar.style.width = '0%';
  doneBtn.style.display = 'none';
  modal.classList.add('open');

  // Build rows for target accounts
  list.innerHTML = eligibleIds.map(id => {
    const s = state.sessions.find(item => item.id === id) || { name: id, phone: '' };
    const name = s.pushName || s.name;
    return `
      <div id="prog-row-${id}" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; font-size: var(--font-size-sm);">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span id="prog-icon-${id}">⏳</span>
          <span style="font-weight: 600;">${name}</span>
          <span style="color: var(--text-secondary); font-size: var(--font-size-xs);">${formatPhone(s.phone)}</span>
        </div>
        <span id="prog-status-${id}" style="font-weight: 600; color: var(--text-secondary);">Queued</span>
      </div>
    `;
  }).join('');

  const isAntiBan = document.getElementById('checkAntiBanStagger')?.checked;
  const autoHours = document.getElementById('autoExpireSelect')?.value || '0';
  const isRepeatDaily = document.getElementById('checkRepeatDaily')?.checked;

  if (isScheduled) {
    const formData = new FormData();
    if (state.selectedFile) formData.append('media', state.selectedFile);
    else if (state.composerMediaUrl) formData.append('mediaUrl', state.composerMediaUrl);
    formData.append('caption', caption);
    formData.append('targetSessionIds', JSON.stringify(eligibleIds));
    formData.append('isScheduled', 'true');
    formData.append('scheduledFor', scheduledFor);
    formData.append('antiBanStagger', isAntiBan ? 'true' : 'false');
    formData.append('autoExpireHours', autoHours);
    formData.append('repeatDaily', isRepeatDaily ? 'true' : 'false');
    formData.append('dripSlot', state.selectedDripSlot || '');

    try {
      const res = await fetch('/api/broadcast', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        bar.style.width = '100%';
        overall.textContent = isRepeatDaily ? '🔁 Recurring daily drip status queued!' : '✅ Status successfully queued in schedule!';
        counter.textContent = `${eligibleIds.length} / ${eligibleIds.length}`;
        eligibleIds.forEach(id => {
          document.getElementById(`prog-icon-${id}`).textContent = '⏰';
          document.getElementById(`prog-status-${id}`).textContent = 'Scheduled';
          document.getElementById(`prog-status-${id}`).style.color = 'var(--accent-purple)';
        });
        showToast('Status scheduled for queue execution!', 'success');
      } else {
        overall.textContent = `❌ Scheduling failed: ${data.error}`;
      }
    } catch (e) {
      overall.textContent = `❌ Error: ${e.message}`;
    }
    doneBtn.style.display = 'block';
    await fetchHistory();
    return;
  }

  // Immediate Push:
  overall.textContent = (isAntiBan && eligibleIds.length > 1)
    ? `🛡️ Dispatching with Anti-Ban smart staggering (3-5s delays)...`
    : `Publishing media and route caption to WhatsApp...`;

  const formData = new FormData();
  if (state.selectedFile) formData.append('media', state.selectedFile);
  else if (state.composerMediaUrl) formData.append('mediaUrl', state.composerMediaUrl);
  formData.append('caption', caption);
  formData.append('targetSessionIds', JSON.stringify(eligibleIds));
  formData.append('isScheduled', 'false');
  formData.append('antiBanStagger', isAntiBan ? 'true' : 'false');
  formData.append('autoExpireHours', autoHours);

  try {
    const res = await fetch('/api/broadcast', { method: 'POST', body: formData });
    const data = await res.json();

    bar.style.width = '100%';
    counter.textContent = `${eligibleIds.length} / ${eligibleIds.length}`;

    // Always update session progress rows with their exact outcome
    (data.results || []).forEach(r => {
      const iconEl = document.getElementById(`prog-icon-${r.sessionId}`);
      const statEl = document.getElementById(`prog-status-${r.sessionId}`);
      if (iconEl && statEl) {
        if (r.status === 'passed') {
          iconEl.textContent = '✅';
          statEl.textContent = 'Published';
          statEl.style.color = 'var(--accent-wa)';
        } else {
          iconEl.textContent = '❌';
          statEl.textContent = r.error || 'Failed';
          statEl.style.color = 'var(--accent-red)';
        }
      }
    });

    if (data.success) {
      overall.textContent = `🎉 Status broadcast completed!`;
      showToast('Status published to WhatsApp accounts!', 'success');
    } else {
      overall.textContent = `Broadcast issue: ${data.error || 'Failed to publish to selected accounts'}`;
    }
  } catch (err) {
    overall.textContent = `Failed: ${err.message}`;
  }

  doneBtn.style.display = 'block';
  await fetchHistory();
  await fetchLiveStatuses();
  updateDuplicateState();
  renderTargetAccountsList();
  updatePushActionState();
}

document.getElementById('btnCloseBroadcastModal').addEventListener('click', () => {
  document.getElementById('broadcastProgressModal').classList.remove('open');
});

// MARK: - Tab 2: Sessions & QR Management
function setupSessions() {
  document.getElementById('btnRefreshSessions').addEventListener('click', async () => {
    await refreshAllData(true);
  });
  document.getElementById('sessionsFilterInput').addEventListener('input', (e) => {
    state.searchQuerySessions = e.target.value.toLowerCase().trim();
    renderSessionsGrid();
  });

  // Batch actions
  document.getElementById('btnStartAll').addEventListener('click', async () => {
    if (!confirm('Start all disconnected WhatsApp sessions?')) return;
    showToast('Starting sessions...', 'info');
    await fetch('/api/sessions/start-all', { method: 'POST' });
    await fetchSessions();
    showToast('Start command dispatched!', 'success');
  });

  document.getElementById('btnStopAll').addEventListener('click', async () => {
    if (!confirm('Stop all running WhatsApp sessions?')) return;
    showToast('Stopping sessions...', 'info');
    await fetch('/api/sessions/stop-all', { method: 'POST' });
    await fetchSessions();
    showToast('Stop command dispatched!', 'success');
  });

  document.getElementById('btnRestartNonReady').addEventListener('click', async () => {
    showToast('Restarting non-ready sessions...', 'info');
    await fetch('/api/sessions/restart-non-ready', { method: 'POST' });
    await fetchSessions();
    showToast('Sessions restarted!', 'success');
  });

  // New session modal
  const newSessionModal = document.getElementById('newSessionModal');
  document.getElementById('btnNewSessionModal').addEventListener('click', () => {
    document.getElementById('newSessionNameInput').value = '';
    newSessionModal.classList.add('open');
  });
  document.getElementById('btnCloseNewSessionModal').addEventListener('click', () => {
    newSessionModal.classList.remove('open');
  });
  document.getElementById('btnConfirmCreateSession').addEventListener('click', async () => {
    const rawName = document.getElementById('newSessionNameInput').value.trim();
    if (!rawName) return alert('Please enter a session name');
    const cleaned = rawName.toLowerCase().replace(/[^a-z0-9-]/g, '-');

    showToast(`Creating session "${cleaned}"...`, 'info');
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleaned })
      });
      const data = await res.json();
      newSessionModal.classList.remove('open');
      if (res.ok) {
        showToast(`Session ${cleaned} created!`, 'success');
        await fetchSessions();
        openQrModal(data.id || cleaned, cleaned);
      } else {
        alert(data.error || 'Failed to create session');
      }
    } catch (e) {
      alert(e.message);
    }
  });
}

async function fetchSessions() {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.sessions = Array.isArray(data) ? data : [];

    // Auto-select all ready sessions if nothing is selected yet
    if (state.selectedSessionIds.size === 0) {
      state.sessions.filter(s => s.status.toLowerCase() === 'ready').forEach(s => state.selectedSessionIds.add(s.id));
    }

    document.getElementById('badgeSessionsCount').textContent = state.sessions.length;
    document.getElementById('sessionsTabTotalBadge').textContent = state.sessions.length;

    renderSessionsGrid();
    renderTargetAccountsList();
    updatePushActionState();
  } catch (err) {
    console.error('Fetch sessions failed:', err);
  }
}

function renderSessionsGrid() {
  const container = document.getElementById('sessionsGridContainer');
  const query = state.searchQuerySessions;

  const filtered = state.sessions.filter(s => {
    if (!query) return true;
    return (
      s.name.toLowerCase().includes(query) ||
      (s.phone && s.phone.includes(query)) ||
      (s.pushName && s.pushName.toLowerCase().includes(query))
    );
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted);">No sessions found matching "${query}"</div>`;
    return;
  }

  container.innerHTML = filtered.map(s => {
    const isReady = s.status.toLowerCase() === 'ready';
    const initial = (s.pushName || s.name || 'W').charAt(0).toUpperCase();
    const phoneDisplay = s.phone ? formatPhone(s.phone) : 'No phone linked';
    const dispName = s.pushName ? s.pushName : s.name;

    let badgeClass = 'badge badge-offline';
    if (isReady) badgeClass = 'badge badge-ready';
    else if (s.status.includes('qr')) badgeClass = 'badge badge-phone-live';

    return `
      <div class="session-card" data-id="${s.id}">
        <div>
          <div class="session-header">
            <div style="display: flex; align-items: center; min-width: 0;">
              <div class="session-avatar">${initial}</div>
              <div class="session-title-wrap">
                <div class="session-title" title="${dispName}">${dispName}</div>
                <div class="session-sub">${phoneDisplay} · <span style="font-family: monospace; font-size: var(--font-size-xs);">${s.name}</span></div>
              </div>
            </div>
            <span class="${badgeClass}">${s.status}</span>
          </div>

          <div style="font-size: var(--font-size-xs); color: var(--text-secondary); margin-top: 6px; display: flex; justify-content: space-between;">
            <span>Engine: ${s.engineLoaded ? '✅ Baileys' : '❌ Offline'}</span>
            <span>${s.lastActive ? 'Active ' + formatTimestamp(s.lastActive) : ''}</span>
          </div>
        </div>

        <div class="session-controls">
          <button class="btn-action-sm" onclick="openQrModal('${s.id}', '${dispName}')">📷 Scan QR</button>
          <button class="btn-action-sm" onclick="restartSession('${s.id}')">🔄 Restart</button>
          ${isReady
            ? `<button class="btn-action-sm" onclick="stopSession('${s.id}')">⏹️ Stop</button>`
            : `<button class="btn-action-sm" onclick="startSession('${s.id}')">▶️ Start</button>`
          }
          <button class="btn-action-sm" onclick="logoutSession('${s.id}')">🚪 Logout</button>
          <button class="btn-action-sm danger" onclick="deleteSession('${s.id}')">🗑️ Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

// Session individual controls
window.startSession = async function(id) {
  showToast('Starting session...', 'info');
  await fetch(`/api/sessions/${id}/start`, { method: 'POST' });
  await fetchSessions();
  showToast('Session started!', 'success');
};

window.stopSession = async function(id) {
  showToast('Stopping session...', 'info');
  await fetch(`/api/sessions/${id}/stop`, { method: 'POST' });
  await fetchSessions();
  showToast('Session stopped!', 'success');
};

window.restartSession = async function(id) {
  showToast('Restarting session...', 'info');
  await fetch(`/api/sessions/${id}/restart`, { method: 'POST' });
  await fetchSessions();
  showToast('Session restarted!', 'success');
};

window.logoutSession = async function(id) {
  if (!confirm('Are you sure you want to log out this WhatsApp session? You will need to scan QR code again.')) return;
  await fetch(`/api/sessions/${id}/logout`, { method: 'POST' });
  await fetchSessions();
  showToast('Session logged out', 'info');
};

window.deleteSession = async function(id) {
  if (!confirm('Are you sure you want to completely delete this session?')) return;
  await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
  await fetchSessions();
  showToast('Session deleted', 'info');
};

// MARK: - QR Code Modal Logic
window.openQrModal = async function(id, name) {
  const modal = document.getElementById('qrModal');
  const title = document.getElementById('qrModalTitle');
  const display = document.getElementById('qrCodeDisplayContainer');
  const qrStatus = document.getElementById('qrStatusMessage');

  state.activeQrSessionId = id;
  title.textContent = `Link Session: ${name}`;
  display.innerHTML = `<div style="color: var(--text-muted); font-size: var(--font-size-base);">Checking session status...</div>`;
  modal.classList.add('open');

  // QR Auto-connect: check if session is already ready
  try {
    const res = await fetch(`/api/sessions/${id}/qr`);
    const data = await res.json();
    if (data.status === 'ready') {
      display.innerHTML = `
        <div style="text-align: center; color: var(--accent-wa); font-weight: 700; padding: 20px;">
          <div style="font-size: 3rem; margin-bottom: 8px;">✅</div>
          <div>WhatsApp Account Already Linked & Ready!</div>
        </div>
      `;
      setTimeout(() => {
        closeQrModal();
        fetchSessions();
      }, 1500);
      return;
    }
  } catch (e) {
    // ignore, proceed to normal QR flow
  }

  // Trigger start just in case it was stopped
  fetch(`/api/sessions/${id}/start`, { method: 'POST' }).catch(() => {});

  pollQrCode();
  if (state.activeQrPolling) clearInterval(state.activeQrPolling);
  state.activeQrPolling = setInterval(pollQrCode, 3000);
};

async function pollQrCode() {
  if (!state.activeQrSessionId) return;
  const id = state.activeQrSessionId;
  const display = document.getElementById('qrCodeDisplayContainer');

  try {
    const res = await fetch(`/api/sessions/${id}/qr`);
    const data = await res.json();

    if (data.status === 'ready') {
      display.innerHTML = `
        <div style="text-align: center; color: var(--accent-wa); font-weight: 700; padding: 20px;">
          <div style="font-size: 3rem; margin-bottom: 8px;">✅</div>
          <div>WhatsApp Account Successfully Linked & Ready!</div>
        </div>
      `;
      setTimeout(() => {
        closeQrModal();
        fetchSessions();
      }, 1500);
      return;
    }

    if (data.qrCode || data.renderedQr) {
      const qrSrc = data.renderedQr || (data.qrCode.startsWith('data:image/') ? data.qrCode : null);
      if (qrSrc) {
        display.innerHTML = `<img src="${qrSrc}" style="width: 250px; height: 250px; display: block;" alt="WhatsApp QR Code" />`;
      } else {
        display.innerHTML = `<div style="padding: 20px; font-family: monospace; font-size: var(--font-size-xs); word-break: break-all;">${data.qrCode}</div>`;
      }
    } else {
      display.innerHTML = `<div style="color: var(--text-muted); font-size: var(--font-size-base);">Waiting for WhatsApp QR generation (${data.status || 'initializing'})...</div>`;
    }
  } catch (err) {
    display.innerHTML = `<div style="color: var(--accent-red); font-size: var(--font-size-base);">Failed to fetch QR: ${err.message}</div>`;
  }
}

function closeQrModal() {
  const modal = document.getElementById('qrModal');
  modal.classList.remove('open');
  if (state.activeQrPolling) {
    clearInterval(state.activeQrPolling);
    state.activeQrPolling = null;
  }
  state.activeQrSessionId = null;
}

document.getElementById('btnCloseQrModal').addEventListener('click', closeQrModal);

// Modal Pairing Code tab toggle
document.getElementById('btnTabQr').addEventListener('click', () => {
  document.getElementById('btnTabQr').classList.add('active');
  document.getElementById('btnTabPairing').classList.remove('active');
  document.getElementById('qrCodeViewWrap').style.display = 'block';
  document.getElementById('pairingCodeViewWrap').style.display = 'none';
});

document.getElementById('btnTabPairing').addEventListener('click', () => {
  document.getElementById('btnTabPairing').classList.add('active');
  document.getElementById('btnTabQr').classList.remove('active');
  document.getElementById('qrCodeViewWrap').style.display = 'none';
  document.getElementById('pairingCodeViewWrap').style.display = 'block';
});

document.getElementById('btnRequestPairingCode').addEventListener('click', async () => {
  const phone = document.getElementById('pairingPhoneInput').value.trim();
  if (!phone) return alert('Please enter phone number with country code (e.g. 917200238633)');

  showToast('Requesting pairing code...', 'info');
  try {
    const res = await fetch(`/api/sessions/${state.activeQrSessionId}/pairing-code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone })
    });
    const data = await res.json();
    if (data.pairingCode) {
      document.getElementById('pairingCodeDisplay').style.display = 'block';
      document.getElementById('pairingCodeText').textContent = data.pairingCode;
      showToast('Pairing code generated!', 'success');
    } else {
      alert(data.error || data.message || 'Failed to get pairing code');
    }
  } catch (e) {
    alert(e.message);
  }
});

// MARK: - Tab 3: History & Queue
function setupHistory() {
  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.historyFilter = btn.getAttribute('data-filter');
      renderHistoryList();
    });
  });

  document.getElementById('historySearchInput').addEventListener('input', (e) => {
    state.searchQueryHistory = e.target.value.toLowerCase().trim();
    renderHistoryList();
  });

  document.getElementById('btnClearHistory').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear all status broadcast history?')) return;
    await fetch('/api/history', { method: 'DELETE' });
    await fetchHistory();
    showToast('Broadcast history cleared', 'info');
  });
}

// MARK: - Theme Toggle (Dark / Light Mode)

function setupThemeToggle() {
  const btn = document.getElementById('btnThemeToggle');
  const icon = document.getElementById('themeToggleIcon');
  const saved = localStorage.getItem('openwa_theme');

  // Apply saved theme or default to dark
  if (saved === 'light') {
    enableLightMode();
  } else {
    disableLightMode();
  }

  btn.addEventListener('click', () => {
    if (document.body.classList.contains('light-theme')) {
      disableLightMode();
      localStorage.setItem('openwa_theme', 'dark');
    } else {
      enableLightMode();
      localStorage.setItem('openwa_theme', 'light');
    }
  });
}

function enableLightMode() {
  document.body.classList.add('light-theme');
  document.getElementById('themeToggleIcon').textContent = '☀️';
}

function disableLightMode() {
  document.body.classList.remove('light-theme');
  document.getElementById('themeToggleIcon').textContent = '🌙';
}

// MARK: - Export Broadcast History (CSV / JSON)

function setupExportHistory() {
  document.getElementById('btnExportHistory').addEventListener('click', () => {
    const format = prompt('Export format? Type "csv" or "json"', 'csv');
    if (!format) return;
    exportHistory(format.trim().toLowerCase());
  });
}

async function exportHistory(format = 'csv') {
  try {
    const res = await fetch(`/api/history/export?format=${format}`);
    if (!res.ok) throw new Error(`Export failed: ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ext = format === 'json' ? 'json' : 'csv';
    const mime = format === 'json' ? 'application/json' : 'text/csv';
    a.href = url;
    a.download = `whatsapp-status-history-${new Date().toISOString().slice(0, 10)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`History exported as ${format.toUpperCase()}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    console.error('Export history failed:', err);
  }
}

// MARK: - Auth UI (user display, logout, manage users)

function setupAuthUI() {
  const headerStatus = document.getElementById('headerStatusGroup');
  if (!headerStatus) return;

  const userInfo = document.createElement('div');
  userInfo.style.display = 'flex';
  userInfo.style.alignItems = 'center';
  userInfo.style.gap = '10px';
  userInfo.style.marginLeft = '12px';
  userInfo.style.padding = '6px 12px';
  userInfo.style.background = 'var(--bg-input)';
  userInfo.style.border = '1px solid var(--border-color)';
  userInfo.style.borderRadius = '20px';
  userInfo.style.fontSize = 'var(--font-size-sm)';
  userInfo.style.fontWeight = '600';
  userInfo.style.color = 'var(--text-secondary)';
  userInfo.innerHTML = `
    <span id="authUserDisplay">${currentUser ? currentUser.username : 'User'} (${currentUser ? currentUser.role : 'user'})</span>
    <button type="button" id="btnManageUsers" style="background:none;border:none;color:var(--accent-blue);cursor:pointer;margin-left:8px;padding:4px 8px;font-size:var(--font-size-xs);">👥 Users</button>
    <button type="button" id="btnLogout" style="background:none;border:none;color:var(--text-secondary);cursor:pointer;margin-left:8px;padding:4px 8px;font-size:var(--font-size-xs);">Logout</button>
  `;
  headerStatus.appendChild(userInfo);

  document.getElementById('btnLogout').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch (e) {
      // ignore
    }
    currentUser = null;
    window.location.href = '/login';
  });

  const btnUsers = document.getElementById('btnManageUsers');
  if (btnUsers) {
    btnUsers.addEventListener('click', () => {
      openUsersModal();
    });
  }
}

// ==================== USERS MANAGEMENT MODAL (ADMIN & USER) ====================

let usersModal = null;
let usersListEl = null;
let addUserFormEl = null;
let addUserMsgEl = null;

function openUsersModal() {
  // Create modal if not exists
  if (!usersModal) {
    const modalHtml = `
      <div class="modal-backdrop" id="usersModal">
        <div class="modal-content">
          <div class="modal-header">
            <div class="modal-title">👥 Manage Users</div>
            <button class="btn-close-modal" id="btnCloseUsersModal" title="Close">✕</button>
          </div>
          <div class="modal-body">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <strong style="font-size: var(--font-size-xs); color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.5px;">Registered Accounts</strong>
                <span id="usersCountBadge" style="background: var(--bg-input); color: var(--accent-wa); padding: 2px 8px; border-radius: 12px; font-size: var(--font-size-xs); font-weight: 700;">0</span>
              </div>
              <div id="usersListContainer"></div>
            </div>
            <hr style="border: none; border-top: 1px solid var(--border-color); margin: 6px 0;" />
            <div class="add-user-card">
              <div class="section-header">
                <span class="section-icon">➕</span>
                <span class="section-title">Add New User</span>
              </div>
              <form id="addUserForm" class="add-user-form">
                <div class="form-group">
                  <label class="form-label" for="newUserUsername">Username</label>
                  <div class="input-wrapper">
                    <span class="input-icon">🏷️</span>
                    <input type="text" class="form-input" id="newUserUsername" placeholder="e.g. operator" autocomplete="off" required />
                  </div>
                  <span class="field-hint">Unique login name for this account</span>
                </div>
                <div class="form-group" style="position: relative;">
                  <label class="form-label" for="newUserPassword">Password</label>
                  <div class="input-wrapper">
                    <span class="input-icon">🔒</span>
                    <input type="password" class="form-input" id="newUserPassword" placeholder="••••••••" required />
                    <button type="button" id="toggleNewUserPassword" class="password-toggle" aria-label="Toggle password visibility">👁️</button>
                  </div>
                  <span class="field-hint">Secure password for the new account</span>
                </div>
                <div class="form-group">
                  <label class="form-label" for="newUserRole">Role</label>
                  <div class="input-wrapper">
                    <span class="input-icon">🛡️</span>
                    <select class="form-input" id="newUserRole" style="cursor: pointer; background: var(--bg-input); color: var(--text-primary);">
                      <option value="user" selected>User (Full Dashboard Access)</option>
                      <option value="admin">Admin (Full Dashboard Access)</option>
                    </select>
                  </div>
                  <span class="field-hint">Account role (both have full dashboard & user management access)</span>
                </div>
                <button type="submit" class="btn-add-user" id="btnAddUser">
                  <span>➕</span> Create User
                </button>
                <div id="addUserMsg" class="action-msg" style="display: none;"></div>
              </form>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    usersModal = document.getElementById('usersModal');
    usersListEl = document.getElementById('usersListContainer');
    addUserFormEl = document.getElementById('addUserForm');
    addUserMsgEl = document.getElementById('addUserMsg');

    document.getElementById('btnCloseUsersModal').addEventListener('click', closeUsersModal);
    usersModal.addEventListener('click', (e) => {
      if (e.target === usersModal) closeUsersModal();
    });

    // Password show/hide toggle for new user form
    const toggleNewUserPassword = document.getElementById('toggleNewUserPassword');
    const newUserPasswordInput = document.getElementById('newUserPassword');
    let newUserPasswordVisible = false;
    toggleNewUserPassword.addEventListener('click', () => {
      newUserPasswordVisible = !newUserPasswordVisible;
      newUserPasswordInput.type = newUserPasswordVisible ? 'text' : 'password';
      toggleNewUserPassword.textContent = newUserPasswordVisible ? '🙈' : '👁️';
    });

    addUserFormEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = document.getElementById('newUserUsername').value.trim();
      const password = document.getElementById('newUserPassword').value;
      const role = document.getElementById('newUserRole') ? document.getElementById('newUserRole').value : 'user';
      if (!username || !password) {
        showAddUserMsg('Username and password are required', 'error');
        return;
      }
      try {
        const res = await fetch('/api/auth/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ username, password, role }),
        });
        const data = await res.json();
        if (res.ok) {
          showAddUserMsg(`User "${username}" (${role}) added successfully!`, 'success');
          addUserFormEl.reset();
          loadUsersList();
        } else {
          showAddUserMsg(data.error || 'Failed to add user', 'error');
        }
      } catch (err) {
        showAddUserMsg(err.message, 'error');
      }
    });
  }

  loadUsersList();
  usersModal.classList.add('open');
}

function closeUsersModal() {
  if (usersModal) usersModal.classList.remove('open');
}

async function loadUsersList() {
  try {
    const res = await fetch('/api/auth/users', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    const users = data.users || [];
    document.getElementById('usersCountBadge').textContent = users.length;

    usersListEl.innerHTML = users.map(u => {
      const isPrimaryAdmin = u.username === 'admin';
      return `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: var(--radius-md); font-size: var(--font-size-sm);">
          <div>
            <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(u.username)}</div>
            <div style="font-size: var(--font-size-xs); color: var(--text-muted);">ID: ${u.id} • Created: ${new Date(u.createdAt).toLocaleDateString()}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 6px;">
            <span style="background: ${u.role === 'admin' ? 'rgba(37, 211, 102, 0.15)' : 'rgba(83, 189, 235, 0.15)'}; color: ${u.role === 'admin' ? 'var(--accent-wa)' : 'var(--accent-blue)'}; padding: 2px 8px; border-radius: 10px; font-size: var(--font-size-xs); font-weight: 700; text-transform: uppercase;">${u.role}</span>
            ${!isPrimaryAdmin ? `<button type="button" class="btn-revoke" onclick="deleteUser(${u.id})" style="padding: 4px 8px; font-size: var(--font-size-xs); margin-left: 6px;" title="Delete user">🗑️</button>` : ''}
          </div>
        </div>
      `;
    }).join('') || '<div style="padding: 12px; color: var(--text-muted); font-size: var(--font-size-sm); text-align: center;">No users found.</div>';
  } catch (e) {
    console.error('Failed to load users:', e);
  }
}

function showAddUserMsg(text, type) {
  if (!addUserMsgEl) return;
  addUserMsgEl.textContent = text;
  addUserMsgEl.style.display = 'block';
  addUserMsgEl.style.color = type === 'success' ? 'var(--accent-wa)' : 'var(--accent-red)';
  addUserMsgEl.style.background = type === 'success' ? 'rgba(37, 211, 102, 0.1)' : 'rgba(234, 67, 53, 0.1)';
  addUserMsgEl.style.padding = '6px 10px';
  addUserMsgEl.style.borderRadius = 'var(--radius-sm)';
  addUserMsgEl.style.border = `1px solid ${type === 'success' ? 'rgba(37, 211, 102, 0.3)' : 'rgba(234, 67, 53, 0.3)'}`;
  setTimeout(() => { addUserMsgEl.style.display = 'none'; }, 4000);
}

async function deleteUser(userId) {
  if (!confirm('Are you sure you want to delete this user?')) return;
  try {
    const res = await fetch(`/api/auth/users/${userId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (res.ok) {
      loadUsersList();
    } else {
      const data = await res.json().catch(() => ({}));
      alert(data.error || 'Failed to delete user');
    }
  } catch (err) {
    alert(err.message);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Call closeUsersModal globally for inline onclick
window.closeUsersModal = closeUsersModal;
window.deleteUser = deleteUser;

async function fetchHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    state.historyItems = data.items || [];
    state.historyStats = data.stats || { total: 0, passed: 0, revoked: 0, failed: 0, scheduled: 0 };

    // Update stat cards
    document.getElementById('statTotalCount').textContent = state.historyStats.total;
    document.getElementById('statPassedCount').textContent = state.historyStats.passed;
    document.getElementById('statRevokedCount').textContent = state.historyStats.revoked;
    document.getElementById('statFailedCount').textContent = state.historyStats.failed;
    document.getElementById('statQueueCount').textContent = state.historyStats.scheduled;
    document.getElementById('badgeHistoryCount').textContent = state.historyItems.length;

    renderHistoryList();
  } catch (err) {
    console.error('Fetch history failed:', err);
  }
}

function renderHistoryList() {
  const container = document.getElementById('historyListContainer');
  const filter = state.historyFilter;
  const query = state.searchQueryHistory;

  const filtered = state.historyItems.filter(item => {
    // Status filter
    if (filter === 'passed' && item.status !== 'passed') return false;
    if (filter === 'scheduled' && item.status !== 'scheduled') return false;
    if (filter === 'revoked' && item.status !== 'revoked' && item.status !== 'partially_revoked') return false;
    if (filter === 'failed' && item.status !== 'failed') return false;

    // Search query
    if (query) {
      const matchFile = (item.fileName || '').toLowerCase().includes(query);
      const matchCaption = (item.caption || '').toLowerCase().includes(query);
      const matchUser = (item.createdBy || 'admin').toLowerCase().includes(query) || (item.revokedBy || '').toLowerCase().includes(query);
      return matchFile || matchCaption || matchUser;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">No history records match this filter.</div>`;
    return;
  }

  container.innerHTML = filtered.map(item => {
    const isScheduled = item.status === 'scheduled';
    const isRevoked = item.status === 'revoked' || item.status === 'partially_revoked';
    const isPassed = item.status === 'passed';
    const creator = item.createdBy || 'admin';
    const revoker = item.revokedBy;
    const retrier = item.lastRetriedBy;

    let badgeText = (item.status || '').toUpperCase();
    let badgeClass = 'badge badge-offline';
    if (isPassed) badgeClass = 'badge badge-ready';
    else if (isScheduled) badgeClass = 'badge badge-phone-live';
    else if (isRevoked) badgeClass = 'badge badge-live';

    const targetCount = item.targetSessionIds ? item.targetSessionIds.length : (item.sessionResults ? item.sessionResults.length : 0);
    const passedResults = (item.sessionResults || []).filter(sr => sr.status === 'passed');
    const canRevoke = passedResults.length > 0 && item.status !== 'revoked';

    const timeText = isScheduled
      ? `⏰ Scheduled for ${formatTimestamp(item.scheduledFor)} (${formatCountdown(item.scheduledFor)})`
      : `Published ${formatTimestamp(item.createdAt)}`;

    return `
      <div class="history-item-card" data-id="${item.id}">
        <div class="history-item-header">
          <div style="display: flex; gap: 14px; min-width: 0; flex: 1;">
            <div style="font-size: 2.5rem; line-height: 1; user-select: none;">📄</div>
            <div class="history-content">
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <strong style="font-size: var(--font-size-base); color: var(--text-primary);">${escapeHtml(item.fileName || 'Status Media')}</strong>
                <span class="${badgeClass}">${badgeText}</span>
                <span class="badge badge-user-log" title="Logged by ${escapeHtml(creator)}">👤 ${escapeHtml(creator)}</span>
                ${item.repeatDaily ? `<span class="badge badge-phone-live">🔁 Daily Drip</span>` : ''}
                ${item.autoExpireHours ? `<span class="badge badge-flash-sale">⚡ Flash (${item.autoExpireHours}h)</span>` : ''}
              </div>
              <div class="history-meta">
                <span>${timeText}</span>
                <span>🎯 ${targetCount} Target Account${targetCount === 1 ? '' : 's'}</span>
                <span>👤 Posted by: <strong style="color: var(--accent-blue);">${escapeHtml(creator)}</strong></span>
                ${revoker ? `<span>↩️ Revoked by: <strong style="color: var(--accent-orange);">${escapeHtml(revoker)}</strong></span>` : ''}
                ${retrier ? `<span>🔄 Retried by: <strong style="color: var(--accent-orange);">${escapeHtml(retrier)}</strong></span>` : ''}
              </div>
              ${item.caption ? `<div class="history-caption">${escapeHtml(item.caption)}</div>` : ''}
            </div>
          </div>

          <div class="history-actions">
            ${canRevoke ? `<button class="btn-revoke" onclick="revokeHistoryItem('${item.id}')">↩️ Revoke Status</button>` : ''}
            ${item.status === 'failed' ? `<button class="btn-action-sm" style="background: var(--accent-orange); color: white;" onclick="retryFailedHistory('${item.id}')">🔄 Retry Failed</button>` : ''}
            <button class="btn-action-sm danger" onclick="deleteHistoryItem('${item.id}')">🗑️</button>
          </div>
        </div>

        <!-- Session results breakdown collapse -->
        ${(item.sessionResults && item.sessionResults.length > 0) ? `
          <details style="font-size: var(--font-size-xs); color: var(--text-secondary); margin-top: 4px;">
            <summary style="cursor: pointer; font-weight: 600; padding: 2px 0;">
              View Delivery Breakdown (${passedResults.length} / ${item.sessionResults.length} delivered)
            </summary>
            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 8px; max-height: 150px; overflow-y: auto;">
              ${item.sessionResults.map(sr => `
                <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 8px; background: var(--bg-input); border-radius: 4px;">
                  <span>${sr.name || sr.sessionId}</span>
                  <div style="display: flex; align-items: center; gap: 8px;">
                    ${sr.statusId ? `
                      <button type="button" class="btn-viewers-badge" onclick="event.stopPropagation(); openViewersModal('${sr.statusId}')">
                        👁️ Viewers
                      </button>
                    ` : ''}
                    <span style="color: ${sr.status === 'passed' ? 'var(--accent-wa)' : sr.status === 'revoked' ? 'var(--accent-orange)' : 'var(--accent-red)'}; font-weight: 700;">
                      ${sr.status.toUpperCase()}
                    </span>
                  </div>
                </div>
              `).join('')}
            </div>
          </details>
        ` : ''}
      </div>
    `;
  }).join('');
}

// MARK: - Scheduled Broadcast Management

async function fetchScheduled() {
  try {
    const res = await fetch('/api/scheduled', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    state.scheduledItems = data.items || [];
    renderScheduledList();
  } catch (err) {
    console.error('Fetch scheduled failed:', err);
  }
}

function renderScheduledList() {
  const container = document.getElementById('scheduledListContainer');
  if (!container) return;

  const items = state.scheduledItems;
  if (items.length === 0) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">No scheduled broadcasts.</div>`;
    return;
  }

  container.innerHTML = items.map(item => {
    const creator = item.createdBy || 'admin';
    return `
    <div class="scheduled-item-card" data-id="${item.id}">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <div style="font-weight: 600; color: var(--text-primary);">${escapeHtml(item.fileName || 'Status Media')}</div>
            <span class="badge badge-user-log" title="Queued by ${escapeHtml(creator)}">👤 ${escapeHtml(creator)}</span>
            ${item.repeatDaily ? `<span class="badge badge-phone-live">🔁 Daily Drip</span>` : ''}
          </div>
          <div style="font-size: var(--font-size-xs); color: var(--text-secondary); margin-top: 3px;">
            ⏰ ${formatTimestamp(item.scheduledFor)} • 🎯 ${item.targetSessionIds ? item.targetSessionIds.length : 0} accounts • 👤 Queued by: <strong style="color: var(--accent-blue);">${escapeHtml(creator)}</strong>
          </div>
          ${item.caption ? `<div style="font-size: var(--font-size-sm); color: var(--text-muted); margin-top: 4px; max-height: 40px; overflow: hidden;">${escapeHtml(item.caption)}</div>` : ''}
        </div>
        <div style="display: flex; gap: 8px; flex-shrink: 0;">
          <button class="btn-action-sm danger" onclick="cancelScheduled('${item.id}')" title="Cancel">
            ❌ Cancel
          </button>
        </div>
      </div>
    </div>
  `;
  }).join('');
}

window.cancelScheduled = async function(id) {
  if (!confirm('Cancel this scheduled broadcast?')) return;
  try {
    const res = await fetch(`/api/scheduled/${id}`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      showToast('Scheduled broadcast cancelled', 'success');
      await fetchScheduled();
      await fetchHistory();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to cancel', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// MARK: - Retry Failed Broadcast

window.retryFailedHistory = async function(id) {
  if (!confirm('Retry all failed sessions for this broadcast?')) return;
  showToast('Retrying failed sessions...', 'info');
  try {
    const res = await fetch(`/api/history/${id}/retry-failed`, { method: 'POST', credentials: 'include' });
    const data = await res.json();
    if (res.ok) {
      showToast(`Retry complete: ${data.results.filter(r => r.status === 'passed').length} succeeded`, 'success');
      await fetchHistory();
    } else {
      showToast(data.error || 'Retry failed', 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.revokeHistoryItem = async function(id) {
  if (!confirm('Are you sure you want to revoke and delete this status from all connected WhatsApp accounts?')) return;
  showToast('Revoking status from WhatsApp...', 'info');

  try {
    const res = await fetch(`/api/history/${id}/revoke`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Status revoked from ${data.successCount} accounts!`, 'success');
      await fetchHistory();
      await fetchLiveStatuses();
      updateDuplicateState();
      renderTargetAccountsList();
    } else {
      showToast(data.error || 'Failed to revoke status', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
};

window.deleteHistoryItem = async function(id) {
  if (!confirm('Remove this record from history?')) return;
  await fetch(`/api/history/${id}`, { method: 'DELETE' });
  await fetchHistory();
  showToast('Item removed from history', 'info');
};

// MARK: - Tab 4: Live Statuses Query & Duplicate Detection
function setupLiveStatuses() {
  document.getElementById('btnRefreshLive')?.addEventListener('click', async () => {
    await refreshAllData(true);
  });

  document.getElementById('btnClearAllLiveStatuses')?.addEventListener('click', () => {
    window.clearAllLiveStatuses();
  });

  const btnViewAccount = document.getElementById('btnLiveViewAccount');
  const btnViewGrid = document.getElementById('btnLiveViewGrid');

  if (btnViewAccount && btnViewGrid) {
    btnViewAccount.addEventListener('click', () => {
      state.liveViewMode = 'account';
      btnViewAccount.classList.add('active');
      btnViewGrid.classList.remove('active');
      renderLiveStatusesGrid();
    });

    btnViewGrid.addEventListener('click', () => {
      state.liveViewMode = 'grid';
      btnViewGrid.classList.add('active');
      btnViewAccount.classList.remove('active');
      renderLiveStatusesGrid();
    });
  }

  document.getElementById('liveSearchInput').addEventListener('input', (e) => {
    state.searchQueryLive = e.target.value.toLowerCase().trim();
    renderLiveStatusesGrid();
  });

  const autoToggle = document.getElementById('autoRefreshLiveToggle');
  autoToggle.addEventListener('change', () => {
    if (autoToggle.checked) {
      startLiveAutoRefresh();
    } else {
      stopLiveAutoRefresh();
    }
  });

  startLiveAutoRefresh();
}

function startLiveAutoRefresh() {
  stopLiveAutoRefresh();
  state.autoRefreshLiveTimer = setInterval(fetchLiveStatuses, 30000); // 30s
}

function stopLiveAutoRefresh() {
  if (state.autoRefreshLiveTimer) {
    clearInterval(state.autoRefreshLiveTimer);
    state.autoRefreshLiveTimer = null;
  }
}

async function fetchLiveStatuses() {
  const refreshBtn = document.getElementById('btnRefreshLive');
  if (refreshBtn) refreshBtn.textContent = '🔄 Querying...';

  try {
    const res = await fetch('/api/live-statuses');
    const data = await res.json();
    state.liveStatuses = data.statuses || [];

    document.getElementById('badgeLiveCount').textContent = state.liveStatuses.length;
    document.getElementById('liveStoriesTotalBadge').textContent = state.liveStatuses.length;

    renderLiveStatusesGrid();
    updateDuplicateState();
    updatePushActionState();
  } catch (err) {
    console.error('Fetch live statuses failed:', err);
  } finally {
    if (refreshBtn) refreshBtn.textContent = '🔄 Refresh Stories';
  }
}

function renderLiveStatusesGrid() {
  const container = document.getElementById('liveStoriesContainer');
  if (!container) return;
  const noticeBar = document.getElementById('liveDuplicateNoticeBar');
  const query = state.searchQueryLive;

  const duplicatesExist = state.liveStatuses.some(st => st.isDuplicate);
  if (noticeBar) noticeBar.style.display = duplicatesExist ? 'block' : 'none';

  const filtered = state.liveStatuses.filter(st => {
    if (!query) return true;
    return (
      st.sessionName.toLowerCase().includes(query) ||
      (st.phone && st.phone.includes(query)) ||
      (st.pushName && st.pushName.toLowerCase().includes(query)) ||
      (st.caption && st.caption.toLowerCase().includes(query))
    );
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 40px; text-align: center; color: var(--text-muted);">No active WhatsApp stories found${query ? ` matching "${query}"` : ''}.</div>`;
    return;
  }

  // Helper to generate a single story card HTML
  const generateStoryCardHtml = (st) => {
    const isVideo = st.type === 'video';
    const cardClass = st.isDuplicate ? 'story-card duplicate-highlight' : 'story-card';
    const mediaProxyUrl = st.mediaUrl ? `/api/media-proxy?url=${encodeURIComponent(st.mediaUrl)}` : null;
    const expiresHours = Math.max(1, Math.round((new Date(st.expiresAt) - Date.now()) / (3600 * 1000)));

    return `
      <div class="${cardClass}" data-id="${st.id}">
        ${st.isDuplicate ? `
          <div class="story-banner-dup">
            ⚠️ DUPLICATE: Posted ${st.duplicateRepeatCount}x on this Account!
          </div>
        ` : ''}

        <div class="story-media-box thumbnail-clickable" onclick="openLightbox('${st.id}')">
          ${mediaProxyUrl ? (
            isVideo
              ? `<video src="${mediaProxyUrl}" style="width: 100%; height: 100%; object-fit: contain; pointer-events: none;"></video>`
              : `<img src="${mediaProxyUrl}" loading="lazy" style="width: 100%; height: 100%; object-fit: contain;" alt="Status Media" />`
          ) : `
            <div style="font-size: 3rem; color: #555;">💬</div>
          `}
        </div>

        <div class="story-body">
          <div class="story-account-info">
            <div>
              <div class="story-account-name">${st.pushName || st.sessionName}</div>
              <div style="font-size: var(--font-size-xs); color: var(--text-secondary);">${formatPhone(st.phone)}</div>
            </div>
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
              ${st.broadcastGroupCount > 1 ? `<span class="badge badge-phone-live" title="Live on ${st.broadcastGroupCount} connected accounts">👥 ${st.broadcastGroupCount} Accounts</span>` : ''}
              <span class="badge badge-offline">${st.origin}</span>
              <span class="badge badge-ready">${st.type.toUpperCase()}</span>
            </div>
          </div>

          <div style="font-size: var(--font-size-xs); color: var(--text-muted); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 4px;">
            <span>${formatTimestamp(st.timestamp)}</span>
            <div style="display: flex; gap: 6px; align-items: center;">
              ${st.isFlashSale && st.autoExpireAt ? `
                <span class="badge badge-flash-sale" title="Flash sale: auto-deletes when time expires">⚡ Flash (${formatRemainingTime(st.autoExpireAt)})</span>
              ` : `
                <span>Expires in ${expiresHours}h</span>
              `}
              <button type="button" class="btn-viewers-badge" onclick="event.stopPropagation(); openViewersModal('${st.id}')" title="Click to view reader receipts">
                👁️ ${st.viewersCount || 0}
              </button>
            </div>
          </div>

          <div class="story-caption-text" id="caption-preview-${st.id}">
            ${st.caption ? st.caption : '<span style="color: var(--text-muted); font-style: italic;">No caption</span>'}
          </div>
          ${st.caption && st.caption.length > 110 ? `
            <button type="button" class="btn-action-sm" style="font-size: var(--font-size-xs); padding: 2px 8px; align-self: flex-start; margin-top: -4px;" onclick="toggleCaptionExpand('${st.id}')" id="btn-expand-${st.id}">
              🔍 View Full Flyer Text
            </button>
          ` : ''}

          <div class="story-footer-actions" style="display: flex; gap: 6px;">
            <button class="btn-story-action" style="flex: 1;" onclick="useStatusInComposer('${st.id}')" title="Transfer caption and media to composer">
              ✍️ Modify
            </button>
            <button class="btn-story-action delete" style="flex: 1;" onclick="removeLiveStatus('${st.sessionId}', '${st.id}')" title="Delete from this account">
              🗑️ Remove
            </button>
          </div>
        </div>
      </div>
    `;
  };

  if (state.liveViewMode === 'account') {
    // Group stories by sessionId
    const accountGroups = {};
    for (const st of filtered) {
      if (!accountGroups[st.sessionId]) {
        accountGroups[st.sessionId] = [];
      }
      accountGroups[st.sessionId].push(st);
    }

    const groupKeys = Object.keys(accountGroups);
    container.innerHTML = groupKeys.map(sid => {
      const stories = accountGroups[sid];
      const first = stories[0];
      const initial = (first.pushName || first.sessionName || 'W').charAt(0).toUpperCase();
      const hasDups = stories.some(s => s.isDuplicate);
      const dupCount = stories.filter(s => s.isDuplicate).length;
      const safeAccName = (first.pushName || first.sessionName || '').replace(/'/g, "\\'");

      return `
        <div class="account-stories-group ${hasDups ? 'has-duplicates' : ''}" data-session-id="${sid}">
          <div class="account-stories-header">
            <div class="account-stories-info">
              <div class="session-avatar">${initial}</div>
              <div>
                <div style="font-size: var(--font-size-md); font-weight: 600; color: var(--text-primary);">
                  ${first.pushName || first.sessionName}
                </div>
                <div style="font-size: var(--font-size-xs); color: var(--text-secondary);">
                  ${formatPhone(first.phone)} · <span style="font-family: monospace;">${first.sessionName}</span>
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 8px;">
              ${hasDups ? `
                <span class="badge badge-phone-live">
                  ⚠️ ${dupCount} Duplicate Stories
                </span>
              ` : ''}
              <span class="badge badge-ready">
                ${stories.length} Active ${stories.length === 1 ? 'Story' : 'Stories'}
              </span>
              <button type="button" class="btn-action-sm" onclick="clearSessionStories('${sid}', '${safeAccName}')" style="color: var(--accent-red); border: 1px solid rgba(239, 68, 68, 0.35); background: rgba(239, 68, 68, 0.08); padding: 4px 10px; font-size: var(--font-size-xs); font-weight: 600; border-radius: var(--radius-sm); cursor: pointer;" title="Delete all live stories for this account">
                🗑️ Clear
              </button>
            </div>
          </div>

          <div class="account-stories-grid">
            ${stories.map(generateStoryCardHtml).join('')}
          </div>
        </div>
      `;
    }).join('');

  } else {
    // All Stories view (flat grid)
    container.innerHTML = `
      <div class="live-statuses-grid">
        ${filtered.map(generateStoryCardHtml).join('')}
      </div>
    `;
  }
}

window.toggleCaptionExpand = function(id) {
  const el = document.getElementById(`caption-preview-${id}`);
  const btn = document.getElementById(`btn-expand-${id}`);
  if (!el || !btn) return;
  if (el.style.maxHeight === 'none') {
    el.style.maxHeight = '90px';
    btn.textContent = '🔍 View Full Flyer Text';
  } else {
    el.style.maxHeight = 'none';
    btn.textContent = '▲ Show Less';
  }
};

window.removeLiveStatus = async function(sessionId, statusId) {
  if (!confirm('Are you sure you want to remove this story? It will be removed immediately from the dashboard and WhatsApp.')) return;
  showToast('Removing story...', 'info');

  try {
    const res = await fetch(`/api/live-statuses/${sessionId}/${encodeURIComponent(statusId)}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      showToast('Story removed successfully!', 'success');
      // Optimistically remove from state.liveStatuses immediately
      state.liveStatuses = state.liveStatuses.filter(st => st.id !== statusId);
      const badgeLive = document.getElementById('badgeLiveCount');
      if (badgeLive) badgeLive.textContent = state.liveStatuses.length;
      const totalBadge = document.getElementById('liveStoriesTotalBadge');
      if (totalBadge) totalBadge.textContent = state.liveStatuses.length;
      renderLiveStatusesGrid();
      await fetchLiveStatuses();
      if (typeof fetchHistory === 'function') await fetchHistory();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to remove story', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
};

// Delete status across ALL session accounts simultaneously
window.deleteStatusFromAllAccounts = async function(sessionId, statusId) {
  const item = state.liveStatuses.find(st => st.id === statusId && st.sessionId === sessionId)
            || state.liveStatuses.find(st => st.id === statusId);

  const count = item && item.broadcastGroupCount ? item.broadcastGroupCount : 'all';
  const names = (item && item.broadcastGroupSessions && item.broadcastGroupSessions.length > 0)
    ? item.broadcastGroupSessions.map(s => s.sessionName || s.sessionId).join(', ')
    : 'all connected accounts';

  const confirmed = confirm(
    `⚡ DELETE FROM ALL ACCOUNTS AT ONCE?\n\n` +
    `This status is live across ${count} connected accounts:\n${names}\n\n` +
    `This will immediately and permanently revoke this status flyer from ALL ${count} accounts on WhatsApp.\n\n` +
    `Do you want to proceed?`
  );
  if (!confirmed) return;

  showToast(`Deleting status across ${count} accounts...`, 'info');

  try {
    const res = await fetch('/api/live-statuses/delete-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        sessionId,
        statusId,
        historyItemId: item ? item.historyItemId : null,
        targets: item && item.broadcastGroupSessions ? item.broadcastGroupSessions : undefined
      })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Successfully deleted from all ${data.deletedCount} accounts!`, 'success');
      
      // Optimistically remove all related status IDs from state.liveStatuses
      if (item && item.broadcastGroupSessions) {
        const deletedIds = new Set(item.broadcastGroupSessions.map(s => s.statusId));
        deletedIds.add(statusId);
        state.liveStatuses = state.liveStatuses.filter(st => !deletedIds.has(st.id));
      } else {
        state.liveStatuses = state.liveStatuses.filter(st => st.id !== statusId);
      }

      const badgeLive = document.getElementById('badgeLiveCount');
      if (badgeLive) badgeLive.textContent = state.liveStatuses.length;
      const totalBadge = document.getElementById('liveStoriesTotalBadge');
      if (totalBadge) totalBadge.textContent = state.liveStatuses.length;

      renderLiveStatusesGrid();
      await fetchLiveStatuses();
      if (typeof fetchHistory === 'function') await fetchHistory();
    } else {
      showToast(data.error || 'Failed to delete from all accounts', 'error');
    }
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
};

window.clearAllLiveStatuses = async function() {
  const count = state.liveStatuses ? state.liveStatuses.length : 0;
  if (count === 0) {
    showToast('No active stories found to delete.', 'info');
    return;
  }
  const confirmed = confirm(
    `⚡ DELETE ALL LIVE STATUSES ACROSS ALL ACCOUNTS?\n\n` +
    `There are currently ${count} active WhatsApp stories in the dashboard.\n\n` +
    `This will immediately and permanently revoke ALL live status flyers across all connected WhatsApp accounts.\n\n` +
    `Do you want to proceed?`
  );
  if (!confirmed) return;

  showToast(`Deleting all ${count} active stories across accounts...`, 'info');

  try {
    const res = await fetch('/api/live-statuses/clear-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Successfully deleted all ${data.count || count} stories across all accounts!`, 'success');
      state.liveStatuses = [];
      const badgeLive = document.getElementById('badgeLiveCount');
      if (badgeLive) badgeLive.textContent = '0';
      const totalBadge = document.getElementById('liveStoriesTotalBadge');
      if (totalBadge) totalBadge.textContent = '0';
      renderLiveStatusesGrid();
      await fetchLiveStatuses();
      if (typeof fetchHistory === 'function') await fetchHistory();
    } else {
      showToast(data.error || 'Failed to clear all live statuses', 'error');
    }
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
};

window.clearSessionStories = async function(sessionId, sessionName) {
  const count = (state.liveStatuses || []).filter(st => st.sessionId === sessionId).length;
  if (count === 0) {
    showToast(`No active stories for ${sessionName || 'this account'}.`, 'info');
    return;
  }
  const confirmed = confirm(
    `🗑️ CLEAR STORIES FOR ${sessionName ? sessionName.toUpperCase() : 'THIS ACCOUNT'}?\n\n` +
    `This will delete all ${count} active WhatsApp stories on this account.\n\n` +
    `Do you want to proceed?`
  );
  if (!confirmed) return;

  showToast(`Clearing stories for ${sessionName}...`, 'info');

  try {
    const res = await fetch('/api/live-statuses/clear-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sessionId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`✅ Successfully deleted stories for ${sessionName}!`, 'success');
      state.liveStatuses = (state.liveStatuses || []).filter(st => st.sessionId !== sessionId);
      const badgeLive = document.getElementById('badgeLiveCount');
      if (badgeLive) badgeLive.textContent = state.liveStatuses.length;
      const totalBadge = document.getElementById('liveStoriesTotalBadge');
      if (totalBadge) totalBadge.textContent = state.liveStatuses.length;
      renderLiveStatusesGrid();
      await fetchLiveStatuses();
      if (typeof fetchHistory === 'function') await fetchHistory();
    } else {
      showToast(data.error || 'Failed to delete stories', 'error');
    }
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
};

// Aliases for compatibility
window.deleteLiveStatus = window.removeLiveStatus;
window.renderLiveStatuses = renderLiveStatusesGrid;

window.useStatusInComposer = function(statusId) {
  const item = state.liveStatuses.find(st => st.id === statusId);
  if (!item) return;

  // Transfer caption
  const captionInput = document.getElementById('captionInput');
  captionInput.value = item.caption || '';
  captionInput.dispatchEvent(new Event('input'));

  // Pre-select this account in the target selector
  state.selectedSessionIds = new Set([item.sessionId]);

  // Set media in composer
  if (item.mediaUrl) {
    state.selectedFile = null;
    state.composerMediaUrl = item.mediaUrl;
    const mediaProxyUrl = `/api/media-proxy?url=${encodeURIComponent(item.mediaUrl)}`;
    const isVideo = item.type === 'video';

    const dropZonePrompt = document.getElementById('dropZonePrompt');
    const dropZonePreview = document.getElementById('dropZonePreview');
    const previewImg = document.getElementById('previewImg');
    const previewVideo = document.getElementById('previewVideo');
    const previewFileName = document.getElementById('previewFileName');
    const previewFileSize = document.getElementById('previewFileSize');

    previewFileName.textContent = `Existing ${item.type.toUpperCase()} from ${item.pushName || item.sessionName}`;
    previewFileSize.textContent = 'Live WhatsApp Media';

    if (isVideo) {
      previewImg.style.display = 'none';
      previewVideo.style.display = 'block';
      previewVideo.src = mediaProxyUrl;
    } else {
      previewVideo.style.display = 'none';
      previewImg.style.display = 'block';
      previewImg.src = mediaProxyUrl;
    }
    dropZonePrompt.style.display = 'none';
    dropZonePreview.style.display = 'flex';
  }

  // Refresh target accounts list & push button state
  renderTargetAccountsList();
  updatePushActionState();

  // Close lightbox if open
  closeLightbox();

  // Switch to Tab 1 (Composer)
  switchTab('tab-composer');
  showToast(`Loaded story from "${item.pushName || item.sessionName}" into Composer for editing!`, 'success');
};

// MARK: - Lightbox Modal Logic
let activeLightboxStatusId = null;

window.openLightbox = function(statusId) {
  const item = state.liveStatuses.find(st => st.id === statusId);
  if (!item) return;
  activeLightboxStatusId = statusId;

  const modal = document.getElementById('lightboxModal');
  const title = document.getElementById('lightboxTitle');
  const subtitle = document.getElementById('lightboxSubtitle');
  const mediaWrap = document.getElementById('lightboxMediaWrap');
  const captionText = document.getElementById('lightboxCaptionText');
  const originBadge = document.getElementById('lightboxOriginBadge');
  const typeBadge = document.getElementById('lightboxTypeBadge');
  const timeText = document.getElementById('lightboxTimeText');
  const btnModify = document.getElementById('btnLightboxModify');
  const btnDelete = document.getElementById('btnLightboxDelete');
  const btnDeleteAll = document.getElementById('btnLightboxDeleteAll');

  title.textContent = item.cleanSummary || 'WhatsApp Story';
  subtitle.textContent = `${item.pushName || item.sessionName} (${formatPhone(item.phone)})`;

  captionText.textContent = item.caption || 'No caption posted with this flyer.';
  originBadge.textContent = item.origin;
  typeBadge.textContent = item.type.toUpperCase();
  timeText.textContent = `Posted ${formatTimestamp(item.timestamp)}`;

  const mediaProxyUrl = item.mediaUrl ? `/api/media-proxy?url=${encodeURIComponent(item.mediaUrl)}` : null;
  const isVideo = item.type === 'video';

  if (mediaProxyUrl) {
    if (isVideo) {
      mediaWrap.innerHTML = `<video src="${mediaProxyUrl}" controls autoplay style="width: 100%; height: 100%; object-fit: contain;"></video>`;
    } else {
      mediaWrap.innerHTML = `<img src="${mediaProxyUrl}" style="width: 100%; height: 100%; object-fit: contain;" alt="Status Media" />`;
    }
  } else {
    mediaWrap.innerHTML = `<div style="font-size: 4rem; color: #666;">💬</div>`;
  }

  btnModify.onclick = () => useStatusInComposer(statusId);
  btnDelete.onclick = () => {
    removeLiveStatus(item.sessionId, statusId);
    closeLightbox();
  };

  if (btnDeleteAll) {
    if (item.broadcastGroupCount > 1) {
      btnDeleteAll.style.display = 'block';
      btnDeleteAll.innerHTML = `⚡ Delete on All ${item.broadcastGroupCount} Accounts at Once`;
      btnDeleteAll.onclick = () => {
        deleteStatusFromAllAccounts(item.sessionId, statusId);
        closeLightbox();
      };
    } else {
      btnDeleteAll.style.display = 'none';
      btnDeleteAll.onclick = null;
    }
  }

  modal.classList.add('open');
};

window.closeLightbox = function() {
  const modal = document.getElementById('lightboxModal');
  if (modal) modal.classList.remove('open');
  const mediaWrap = document.getElementById('lightboxMediaWrap');
  if (mediaWrap) mediaWrap.innerHTML = '';
  activeLightboxStatusId = null;
};

function setupModals() {
  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) {
      e.target.classList.remove('open');
      if (e.target.id === 'qrModal') closeQrModal();
    }
    if (e.target.classList.contains('lightbox-modal')) {
      closeLightbox();
      closeViewersModal();
    }
  });

  document.getElementById('btnCloseLightbox')?.addEventListener('click', closeLightbox);
  document.getElementById('btnCloseViewersModal')?.addEventListener('click', closeViewersModal);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeLightbox();
      closeViewersModal();
      closeQrModal();
      document.getElementById('newSessionModal')?.classList.remove('open');
    }
  });
}

// MARK: - Story Viewers & Insights Modal Logic
window.openViewersModal = async function(statusId) {
  const modal = document.getElementById('viewersModal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.classList.add('open');

  const container = document.getElementById('viewersListContainer');
  const countBadge = document.getElementById('viewersModalCountBadge');
  const searchInput = document.getElementById('viewersSearchInput');
  container.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--text-muted);">Fetching viewer insights...</div>`;

  try {
    const res = await fetch(`/api/live-statuses/${encodeURIComponent(statusId)}/viewers`);
    const data = await res.json();
    const viewers = data.viewers || [];
    countBadge.textContent = viewers.length;

    const renderList = (filterQuery = '') => {
      const q = filterQuery.toLowerCase().trim();
      const filtered = viewers.filter(v => {
        if (!q) return true;
        return (v.name && v.name.toLowerCase().includes(q)) || (v.phone && v.phone.includes(q));
      });

      if (filtered.length === 0) {
        container.innerHTML = `<div style="padding: 40px 20px; text-align: center; color: var(--text-muted); font-size: var(--font-size-sm);">${q ? `No viewers matching "${q}"` : 'No one has viewed this status yet.'}</div>`;
        return;
      }

      container.innerHTML = filtered.map(v => {
        const initial = (v.name || 'W').charAt(0).toUpperCase();
        const timeAgo = formatTimeAgo(v.readAt);
        return `
          <div class="viewer-row-item">
            <div style="display: flex; align-items: center; min-width: 0; flex: 1;">
              <div class="viewer-avatar">${initial}</div>
              <div class="viewer-meta">
                <div class="viewer-name">${escapeHtml(v.name || formatPhone(v.phone))}</div>
                <div class="viewer-phone">📱 ${formatPhone(v.phone)}</div>
              </div>
            </div>
            <div class="viewer-time">
              <span>${timeAgo}</span>
            </div>
          </div>
        `;
      }).join('');
    };

    renderList();

    if (searchInput) {
      searchInput.value = '';
      searchInput.oninput = (e) => renderList(e.target.value);
    }
  } catch (err) {
    container.innerHTML = `<div style="padding: 30px; text-align: center; color: var(--accent-red);">Failed to load viewers: ${err.message}</div>`;
  }
};

window.closeViewersModal = function() {
  const modal = document.getElementById('viewersModal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('open');
  }
};

function formatRemainingTime(isoString) {
  if (!isoString) return '';
  const diffMs = new Date(isoString).getTime() - Date.now();
  if (diffMs <= 0) return 'Expired';
  const hours = Math.floor(diffMs / (3600 * 1000));
  const mins = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatTimeAgo(isoString) {
  if (!isoString) return '';
  const diffMs = Date.now() - new Date(isoString).getTime();
  if (diffMs < 0) return 'Just now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
