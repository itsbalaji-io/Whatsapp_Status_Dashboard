// WhatsApp Status Enterprise Web Hub - Client Application

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
  autoRefreshLiveTimer: null
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
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupComposer();
  setupSessions();
  setupHistory();
  setupLiveStatuses();
  setupModals();

  // Initial load
  refreshAllData();

  // Gateway check every 20 seconds
  setInterval(checkGatewayHealth, 20000);
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
  }
}

async function refreshAllData(showNotification = false) {
  const refreshBtn = document.getElementById('btnRefreshAll');
  if (refreshBtn) refreshBtn.textContent = '🔄 Checking...';

  await Promise.all([
    checkGatewayHealth(),
    fetchSessions(),
    fetchHistory(),
    fetchLiveStatuses()
  ]);

  if (refreshBtn) refreshBtn.textContent = '🔄 Refresh';
  if (showNotification) showToast('All account statuses refreshed!', 'success');
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
    await fetchSessions();
    await fetchLiveStatuses();
    updateDuplicateState();
    renderTargetAccountsList();
    updatePushActionState();
  });

  // Broadcast Push Button
  btnPushStatus.addEventListener('click', executeBroadcast);
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
  state.duplicateSessionIds.clear();
  state.phoneDuplicateMatches = {};

  if (state.selectedFile && state.historyItems.length > 0) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const cleanFileName = state.selectedFile.name.trim().toLowerCase();

    for (const item of state.historyItems) {
      const itemTs = new Date(item.createdAt).getTime();
      if (itemTs < cutoff || item.status === 'revoked') continue;
      if ((item.fileName || '').trim().toLowerCase() !== cleanFileName) continue;

      if (item.status === 'scheduled' && item.targetSessionIds) {
        item.targetSessionIds.forEach(id => state.duplicateSessionIds.add(id));
      } else if (item.sessionResults) {
        item.sessionResults.forEach(sr => {
          if (sr.status === 'passed' && !sr.revokedAt && sr.sessionId) {
            state.duplicateSessionIds.add(sr.sessionId);
          }
        });
      }
    }
  }

  // 2. Phone Live Duplicate Detection by Route Fingerprint matching active stories from WhatsApp
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
  const allDupIds = new Set([...state.duplicateSessionIds, ...Object.keys(state.phoneDuplicateMatches)]);
  const selectedDups = [...state.selectedSessionIds].filter(id => allDupIds.has(id));
  const eligibleSelected = Math.max(0, selectedReadyCount - selectedDups.length);

  if (selectedDups.length > 0) {
    countLabel.textContent = `(${eligibleSelected} new + ${selectedDups.length} live skipped)`;
  } else {
    countLabel.textContent = `(${selectedReadyCount} of ${readySessions.length} ready selected)`;
  }

  // Update Select All / Deselect All text
  const filteredReady = filtered.filter(s => s.status.toLowerCase() === 'ready');
  const allFilteredSelected = filteredReady.length > 0 && filteredReady.every(s => state.selectedSessionIds.has(s.id));
  btnToggleSelectAll.textContent = allFilteredSelected ? 'Deselect All' : 'Select All';

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--text-muted);">No accounts match "${query}"</div>`;
    return;
  }

  container.innerHTML = filtered.map(s => {
    const isReady = s.status.toLowerCase() === 'ready';
    const isSelected = state.selectedSessionIds.has(s.id);
    const isPhoneDup = Boolean(state.phoneDuplicateMatches[s.id]);
    const isHistoryDup = state.duplicateSessionIds.has(s.id);
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
      badgeText = 'LIVE';
      badgeClass = 'badge badge-live';
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
      ? `⚠️ Already live on this account (within 24h). Will be automatically skipped.`
      : '';

    return `
      <div class="${rowClass}" data-id="${s.id}" title="${tooltip}">
        <div class="account-info-group">
          <input type="checkbox" class="account-checkbox" data-id="${s.id}" ${isSelected ? 'checked' : ''} ${!isReady ? 'disabled' : ''} />
          <span style="font-size: 0.85rem;">${dot}</span>
          <div class="account-name-group">
            <div class="account-name">${dispName}</div>
            <div class="account-phone">${phoneDisplay}</div>
          </div>
        </div>
        <span class="${badgeClass}">${badgeText}</span>
      </div>
    `;
  }).join('');

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

  const allDupIds = new Set([...state.duplicateSessionIds, ...Object.keys(state.phoneDuplicateMatches)]);
  const selectedIds = [...state.selectedSessionIds];
  const eligibleIds = selectedIds.filter(id => !allDupIds.has(id));
  const duplicateIds = selectedIds.filter(id => allDupIds.has(id));

  if (selectedCount === 0) {
    btn.disabled = true;
    btn.textContent = isScheduled ? '⏰ Schedule WhatsApp Status' : '🚀 Push Status to Accounts';
    feedback.textContent = '⚠️ Select at least 1 ready WhatsApp account.';
    feedback.className = 'push-feedback-msg warning';
    return;
  }

  // All selected accounts already have this status
  if (eligibleIds.length === 0 && duplicateIds.length > 0) {
    btn.disabled = true;
    btn.textContent = `🚫 Already Live on Selected Account${duplicateIds.length === 1 ? '' : 's'}`;
    feedback.textContent = `⚠️ Duplicate Blocked: This status flyer or route is already live on the selected account(s). Choose other accounts or remove the existing status first.`;
    feedback.className = 'push-feedback-msg warning';
    return;
  }

  // Eligible accounts ready for push
  btn.disabled = eligibleIds.length === 0;

  if (isScheduled) {
    btn.textContent = duplicateIds.length > 0
      ? `⏰ Schedule for ${eligibleIds.length} New Account${eligibleIds.length === 1 ? '' : 's'}`
      : `⏰ Schedule for ${eligibleIds.length} Account${eligibleIds.length === 1 ? '' : 's'}`;
  } else {
    btn.textContent = duplicateIds.length > 0
      ? `🚀 Push to ${eligibleIds.length} New Account${eligibleIds.length === 1 ? '' : 's'}`
      : `🚀 Push Status to ${eligibleIds.length} Account${eligibleIds.length === 1 ? '' : 's'}`;
  }

  if (duplicateIds.length > 0) {
    feedback.textContent = `ℹ️ Will broadcast to ${eligibleIds.length} accounts. (${duplicateIds.length} account${duplicateIds.length === 1 ? '' : 's'} already live and will be skipped).`;
    feedback.className = 'push-feedback-msg info';
  } else {
    feedback.textContent = '';
    feedback.className = 'push-feedback-msg';
  }
}

// Broadcast Execution with Live Session-by-Session Modal
async function executeBroadcast() {
  if (!state.selectedFile && !state.composerMediaUrl) return;

  const allDupIds = new Set([...state.duplicateSessionIds, ...Object.keys(state.phoneDuplicateMatches)]);
  const eligibleIds = [...state.selectedSessionIds].filter(id => !allDupIds.has(id));
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
      <div id="prog-row-${id}" style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: var(--bg-input); border-radius: 6px; font-size: 0.82rem;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span id="prog-icon-${id}">⏳</span>
          <span style="font-weight: 600;">${name}</span>
          <span style="color: var(--text-secondary); font-size: 0.75rem;">${formatPhone(s.phone)}</span>
        </div>
        <span id="prog-status-${id}" style="font-weight: 600; color: var(--text-secondary);">Queued</span>
      </div>
    `;
  }).join('');

  if (isScheduled) {
    const formData = new FormData();
    if (state.selectedFile) formData.append('media', state.selectedFile);
    else if (state.composerMediaUrl) formData.append('mediaUrl', state.composerMediaUrl);
    formData.append('caption', caption);
    formData.append('targetSessionIds', JSON.stringify(eligibleIds));
    formData.append('isScheduled', 'true');
    formData.append('scheduledFor', scheduledFor);

    try {
      const res = await fetch('/api/broadcast', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.success) {
        bar.style.width = '100%';
        overall.textContent = '✅ Status successfully queued in schedule!';
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
  overall.textContent = `Publishing media and route caption to WhatsApp...`;
  const formData = new FormData();
  if (state.selectedFile) formData.append('media', state.selectedFile);
  else if (state.composerMediaUrl) formData.append('mediaUrl', state.composerMediaUrl);
  formData.append('caption', caption);
  formData.append('targetSessionIds', JSON.stringify(eligibleIds));
  formData.append('isScheduled', 'false');

  try {
    const res = await fetch('/api/broadcast', { method: 'POST', body: formData });
    const data = await res.json();

    if (data.success) {
      bar.style.width = '100%';
      counter.textContent = `${eligibleIds.length} / ${eligibleIds.length}`;
      overall.textContent = `🎉 Status broadcast completed!`;

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
      showToast('Status published to WhatsApp accounts!', 'success');
    } else {
      overall.textContent = `Broadcast error: ${data.error || 'Partial failure'}`;
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
  document.getElementById('btnRefreshSessions').addEventListener('click', fetchSessions);
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
                <div class="session-sub">${phoneDisplay} · <span style="font-family: monospace; font-size: 0.7rem;">${s.name}</span></div>
              </div>
            </div>
            <span class="${badgeClass}">${s.status}</span>
          </div>

          <div style="font-size: 0.74rem; color: var(--text-secondary); margin-top: 6px; display: flex; justify-content: space-between;">
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
window.openQrModal = function(id, name) {
  const modal = document.getElementById('qrModal');
  const title = document.getElementById('qrModalTitle');
  const display = document.getElementById('qrCodeDisplayContainer');
  const qrStatus = document.getElementById('qrStatusMessage');

  state.activeQrSessionId = id;
  title.textContent = `Link Session: ${name}`;
  display.innerHTML = `<div style="color: #666; font-size: 0.9rem;">Connecting to WhatsApp...</div>`;
  modal.classList.add('open');

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
        display.innerHTML = `<div style="padding: 20px; font-family: monospace; font-size: 0.8rem; word-break: break-all;">${data.qrCode}</div>`;
      }
    } else {
      display.innerHTML = `<div style="color: #666; font-size: 0.9rem;">Waiting for WhatsApp QR generation (${data.status || 'initializing'})...</div>`;
    }
  } catch (err) {
    display.innerHTML = `<div style="color: var(--accent-red); font-size: 0.9rem;">Failed to fetch QR: ${err.message}</div>`;
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
      return matchFile || matchCaption;
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

    let badgeText = item.status.toUpperCase();
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
                <strong style="font-size: 0.95rem; color: var(--text-primary);">${item.fileName || 'Status Media'}</strong>
                <span class="${badgeClass}">${badgeText}</span>
              </div>
              <div class="history-meta">
                <span>${timeText}</span>
                <span>🎯 ${targetCount} Target Account${targetCount === 1 ? '' : 's'}</span>
              </div>
              ${item.caption ? `<div class="history-caption">${item.caption}</div>` : ''}
            </div>
          </div>

          <div class="history-actions">
            ${canRevoke ? `<button class="btn-revoke" onclick="revokeHistoryItem('${item.id}')">↩️ Revoke Status</button>` : ''}
            <button class="btn-action-sm danger" onclick="deleteHistoryItem('${item.id}')">🗑️</button>
          </div>
        </div>

        <!-- Session results breakdown collapse -->
        ${(item.sessionResults && item.sessionResults.length > 0) ? `
          <details style="font-size: 0.78rem; color: var(--text-secondary); margin-top: 4px;">
            <summary style="cursor: pointer; font-weight: 600; padding: 2px 0;">
              View Delivery Breakdown (${passedResults.length} / ${item.sessionResults.length} delivered)
            </summary>
            <div style="display: flex; flex-direction: column; gap: 4px; margin-top: 8px; max-height: 150px; overflow-y: auto;">
              ${item.sessionResults.map(sr => `
                <div style="display: flex; justify-content: space-between; padding: 4px 8px; background: var(--bg-input); border-radius: 4px;">
                  <span>${sr.name || sr.sessionId}</span>
                  <span style="color: ${sr.status === 'passed' ? 'var(--accent-wa)' : sr.status === 'revoked' ? 'var(--accent-orange)' : 'var(--accent-red)'}; font-weight: 700;">
                    ${sr.status.toUpperCase()}
                  </span>
                </div>
              `).join('')}
            </div>
          </details>
        ` : ''}
      </div>
    `;
  }).join('');
}

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
  document.getElementById('btnRefreshLive').addEventListener('click', fetchLiveStatuses);

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
              <div style="font-size: 0.75rem; color: var(--text-secondary);">${formatPhone(st.phone)}</div>
            </div>
            <div style="display: flex; gap: 4px;">
              <span class="badge badge-offline" style="font-size: 0.65rem;">${st.origin}</span>
              <span class="badge badge-ready" style="font-size: 0.65rem;">${st.type.toUpperCase()}</span>
            </div>
          </div>

          <div style="font-size: 0.74rem; color: var(--text-muted); display: flex; justify-content: space-between;">
            <span>${formatTimestamp(st.timestamp)}</span>
            <span>Expires in ${expiresHours}h</span>
          </div>

          <div class="story-caption-text" id="caption-preview-${st.id}">
            ${st.caption ? st.caption : '<span style="color: var(--text-muted); font-style: italic;">No caption</span>'}
          </div>
          ${st.caption && st.caption.length > 110 ? `
            <button type="button" class="btn-action-sm" style="font-size: 0.72rem; padding: 2px 8px; align-self: flex-start; margin-top: -4px;" onclick="toggleCaptionExpand('${st.id}')" id="btn-expand-${st.id}">
              🔍 View Full Flyer Text
            </button>
          ` : ''}

          <div class="story-footer-actions">
            <button class="btn-story-action" onclick="useStatusInComposer('${st.id}')" title="Transfer caption and media to composer and preselect this account">
              ✍️ Modify in Composer
            </button>
            <button class="btn-story-action delete" onclick="removeLiveStatus('${st.sessionId}', '${st.id}')">
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

      return `
        <div class="account-stories-group ${hasDups ? 'has-duplicates' : ''}" data-session-id="${sid}">
          <div class="account-stories-header">
            <div class="account-stories-info">
              <div class="session-avatar">${initial}</div>
              <div>
                <div style="font-size: 1rem; font-weight: 700; color: var(--text-primary);">
                  ${first.pushName || first.sessionName}
                </div>
                <div style="font-size: 0.78rem; color: var(--text-secondary);">
                  ${formatPhone(first.phone)} · <span style="font-family: monospace;">${first.sessionName}</span>
                </div>
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 8px;">
              ${hasDups ? `
                <span class="badge badge-phone-live" style="font-size: 0.72rem;">
                  ⚠️ ${dupCount} Duplicate Stories
                </span>
              ` : ''}
              <span class="badge badge-ready" style="font-size: 0.72rem;">
                ${stories.length} Active ${stories.length === 1 ? 'Story' : 'Stories'}
              </span>
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
  if (!confirm('Are you sure you want to delete this live story from WhatsApp?')) return;
  showToast('Removing story from WhatsApp...', 'info');

  try {
    const res = await fetch(`/api/live-statuses/${sessionId}/${encodeURIComponent(statusId)}`, {
      method: 'DELETE'
    });
    if (res.ok) {
      showToast('Story removed from WhatsApp!', 'success');
      await fetchLiveStatuses();
    } else {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Failed to remove story', 'error');
    }
  } catch (e) {
    showToast(e.message, 'error');
  }
};

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
    }
  });

  document.getElementById('btnCloseLightbox')?.addEventListener('click', closeLightbox);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeLightbox();
      closeQrModal();
      document.getElementById('newSessionModal')?.classList.remove('open');
    }
  });
}
