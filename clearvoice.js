/**
 * ClearVoice — Main Controller
 *
 * Wires together AudioEngine, VoiceProfile, and SipClient.
 * Drives all UI updates: level meters, state badges, tab switching,
 * enrollment flow, dial pad, and the in-call overlay.
 *
 * State machine:
 *   idle → starting → running → stopping → idle
 *   idle/running + SIP → connecting → registered → calling → in-call → registered
 */

'use strict';

// ── Global instances ─────────────────────────────────────────────────────────
const cvEngine  = new AudioEngine();
const cvProfile = new VoiceProfile();
const cvSip     = new SipClient();

// ── App state ─────────────────────────────────────────────────────────────────
const cvState = {
  engineRunning:    false,
  enrolling:        false,
  selectedDeviceId: undefined,
  sipConnected:     false,
  inCall:           false,
  muted:            false,
  callTimerStart:   null,
  callTimerInterval: null,
  dialNumber:       '',
  rafId:            null,
};

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  cvProfile.load();
  cvUpdateProfileUI();
  cvLoadSipSettings();
  cvPopulateMicDevices();

  // Restore strength slider from localStorage
  const savedStrength = parseFloat(localStorage.getItem('cv_strength') || '0.8');
  const slider = document.getElementById('cv-strength');
  slider.value = savedStrength;
  document.getElementById('cv-strength-val').textContent = Math.round(savedStrength * 100) + '%';

  // Wire SIP state changes
  cvSip.onStateChange(({ state, detail }) => cvOnSipState(state, detail));
  cvSip.onIncoming(({ callerNumber }) => cvOnIncomingCall(callerNumber));

  // PWA: register service worker (enables install prompt + offline cache)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // PWA: capture install prompt (Chrome/Edge/Android)
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    cvState._deferredInstall = e;
    document.getElementById('cv-install-bar').classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    document.getElementById('cv-install-bar').classList.add('hidden');
    cvState._deferredInstall = null;
  });
});

// ── PWA install ───────────────────────────────────────────────────────────────

function cvInstallPwa() {
  const prompt = cvState._deferredInstall;
  if (!prompt) return;
  prompt.prompt();
  prompt.userChoice.then(() => {
    cvState._deferredInstall = null;
    document.getElementById('cv-install-bar').classList.add('hidden');
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function cvSwitchTab(name) {
  document.querySelectorAll('.cv-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  document.querySelectorAll('.cv-tab-content').forEach(d => {
    d.classList.toggle('hidden', d.id !== 'tab-' + name);
  });
  if (name === 'enroll') cvUpdateEnrollTab();
}

// ── Engine controls ───────────────────────────────────────────────────────────

async function cvToggleEngine() {
  if (cvState.engineRunning) {
    await cvStopEngine();
  } else {
    await cvStartEngine();
  }
}

async function cvStartEngine() {
  const btn = document.getElementById('cv-start-btn');
  btn.disabled = true;
  btn.querySelector('#cv-start-text').textContent = 'Starting…';

  cvSetStatus('Starting', false);

  try {
    await cvEngine.start(cvState.selectedDeviceId || undefined);
  } catch (err) {
    console.error('[ClearVoice] Engine start failed:', err);
    cvSetStatus('Mic Error', false, true);
    btn.disabled = false;
    btn.querySelector('#cv-start-text').textContent = 'Start Noise Filter';
    alert('Could not start: ' + err.message);
    return;
  }

  // Apply current profile and strength
  cvEngine.setVoiceProfile(cvProfile.profile);
  cvEngine.setStrength(parseFloat(document.getElementById('cv-strength').value));

  // Register stats handler
  cvEngine.onStats(stats => cvLastStats = stats);

  // Start meter animation loop
  cvState.rafId = requestAnimationFrame(cvAnimateMeters);

  cvState.engineRunning = true;
  btn.disabled = false;
  btn.classList.add('running');
  btn.querySelector('#cv-start-icon').textContent = '⏹';
  btn.querySelector('#cv-start-text').textContent = 'Stop Noise Filter';
  cvSetStatus('Active', true);
}

async function cvStopEngine() {
  if (cvState.rafId) { cancelAnimationFrame(cvState.rafId); cvState.rafId = null; }

  await cvEngine.stop();
  cvState.engineRunning = false;

  const btn = document.getElementById('cv-start-btn');
  btn.classList.remove('running');
  btn.querySelector('#cv-start-icon').textContent = '⏻';
  btn.querySelector('#cv-start-text').textContent = 'Start Noise Filter';
  cvSetStatus('Idle', false);

  // Zero out meters
  cvSetMeter('in',  0, null);
  cvSetMeter('out', 0, null);
  document.getElementById('cv-noise-removed').textContent = '0.0 dB';
}

// ── Meters ────────────────────────────────────────────────────────────────────

let cvLastStats = null;

function cvAnimateMeters() {
  if (!cvState.engineRunning) return;

  // Use AnalyserNode for smooth real-time metering (no worklet delay)
  const rawLevel   = cvEngine.getRawLevel();
  const cleanLevel = cvEngine.getCleanLevel();

  cvSetMeter('in',  rawLevel,   null);
  cvSetMeter('out', cleanLevel, null);

  // Use worklet stats for dB labels and noise-removed display
  if (cvLastStats) {
    const dbIn  = 20 * Math.log10(cvLastStats.rmsIn  + 1e-10);
    const dbOut = 20 * Math.log10(cvLastStats.rmsOut + 1e-10);
    document.getElementById('meter-in-db').textContent  = dbIn  > -60 ? dbIn.toFixed(1) + ' dB'  : '—';
    document.getElementById('meter-out-db').textContent = dbOut > -60 ? dbOut.toFixed(1) + ' dB' : '—';

    const removed = Math.max(0, dbIn - dbOut);
    document.getElementById('cv-noise-removed').textContent = removed.toFixed(1) + ' dB';

    // Voice confidence (how well the current F0 matches the profile)
    if (cvProfile.enrolled && cvLastStats.f0 > 0) {
      const { f0Mean, f0Std } = cvProfile.profile;
      const distance  = Math.abs(cvLastStats.f0 - f0Mean) / (f0Std + 12);
      const confidence = Math.max(0, 1 - distance / 3);
      cvSetConfidence(confidence);
    }
  }

  cvState.rafId = requestAnimationFrame(cvAnimateMeters);
}

/**
 * Update a level meter bar.
 * @param {'in'|'out'} which
 * @param {number} level - 0 to 1 linear amplitude
 * @param {string|null} dbText - label text or null to keep current
 */
function cvSetMeter(which, level, dbText) {
  const pct  = Math.min(100, level * 100 * 2.5); // boost so typical speech is ~70%
  const fill = document.getElementById('meter-' + which + '-fill');
  fill.style.width = pct + '%';
  fill.classList.toggle('hot', pct > 85);
  if (dbText !== null) {
    document.getElementById('meter-' + which + '-db').textContent = dbText;
  }
}

function cvSetConfidence(value) {
  const row = document.getElementById('cv-confidence-row');
  const fill = document.getElementById('cv-confidence-fill');
  const pct  = document.getElementById('cv-confidence-pct');
  row.style.display = 'flex';
  fill.style.width = Math.round(value * 100) + '%';
  pct.textContent  = Math.round(value * 100) + '%';
}

// ── Strength slider ───────────────────────────────────────────────────────────

function cvOnStrength(value) {
  const pct = Math.round(value * 100);
  document.getElementById('cv-strength-val').textContent = pct + '%';
  if (cvState.engineRunning) cvEngine.setStrength(parseFloat(value));
  localStorage.setItem('cv_strength', value);
}

// ── Mic device selector ───────────────────────────────────────────────────────

async function cvPopulateMicDevices() {
  try {
    const devices = await AudioEngine.getInputDevices();
    const sel = document.getElementById('cv-mic-select');
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label;
      sel.appendChild(opt);
    });
  } catch (_) {}
}

function cvOnMicChange(deviceId) {
  cvState.selectedDeviceId = deviceId || undefined;
  // Restart if running to pick up new device
  if (cvState.engineRunning) {
    cvStopEngine().then(() => cvStartEngine());
  }
}

// ── Voice profile UI ──────────────────────────────────────────────────────────

function cvUpdateProfileUI() {
  const badge       = document.getElementById('cv-profile-badge');
  const statusEl    = document.getElementById('cv-profile-status');
  const pitchEl     = document.getElementById('cv-profile-pitch');
  const confRow     = document.getElementById('cv-confidence-row');

  if (cvProfile.enrolled) {
    badge.classList.add('enrolled');
    statusEl.textContent = 'Voice enrolled ✓';
    pitchEl.style.display = 'block';
    pitchEl.textContent = cvProfile.summary;
    confRow.style.display = 'flex';
  } else {
    badge.classList.remove('enrolled');
    statusEl.textContent = 'Not enrolled';
    pitchEl.style.display = 'none';
    confRow.style.display = 'none';
  }

  // Send updated profile to running engine
  if (cvState.engineRunning) {
    cvEngine.setVoiceProfile(cvProfile.profile);
  }
}

// ── Enrollment flow ───────────────────────────────────────────────────────────

function cvUpdateEnrollTab() {
  const statusEl = document.getElementById('enroll-current-status');
  const detailEl = document.getElementById('enroll-current-detail');
  const clearBtn = document.getElementById('enroll-clear-btn');

  if (cvProfile.enrolled) {
    statusEl.className = 'cv-profile-badge enrolled';
    statusEl.innerHTML = '<span class="dot"></span><span>Voice enrolled ✓</span>';
    detailEl.style.display  = 'block';
    detailEl.textContent = cvProfile.summary;
    clearBtn.style.display  = 'block';
  } else {
    statusEl.className = 'cv-profile-badge';
    statusEl.innerHTML = '<span class="dot"></span><span>Not enrolled</span>';
    detailEl.style.display  = 'none';
    clearBtn.style.display  = 'none';
  }
  document.getElementById('enroll-result').style.display = 'none';
  document.getElementById('enroll-progress-wrap').style.display = 'none';
  document.getElementById('enroll-btn').disabled = false;
  document.getElementById('enroll-btn').textContent = '🎙 Start Enrollment';
}

async function cvStartEnrollment() {
  if (cvState.enrolling) return;
  cvState.enrolling = true;

  const btn        = document.getElementById('enroll-btn');
  const progressW  = document.getElementById('enroll-progress-wrap');
  const progressF  = document.getElementById('enroll-progress-fill');
  const progressL  = document.getElementById('enroll-progress-label');
  const pitchDisp  = document.getElementById('enroll-live-pitch');
  const resultDiv  = document.getElementById('enroll-result');
  const instructions = document.getElementById('enroll-instructions');

  btn.disabled       = true;
  btn.innerHTML      = '<span class="cv-spinner"></span> Recording…';
  progressW.style.display = 'block';
  resultDiv.style.display = 'none';
  instructions.style.display = 'none';

  // Get a fresh mic stream for enrollment
  let micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert('Microphone access needed for enrollment: ' + err.message);
    cvState.enrolling = false;
    btn.disabled = false;
    btn.innerHTML = '🎙 Start Enrollment';
    progressW.style.display = 'none';
    instructions.style.display = 'block';
    return;
  }

  const DURATION = 10;
  let lastPitch  = 0;

  // Pitch monitor using a parallel ScriptProcessor (read-only, doesn't affect stream)
  const pitchCtx  = new AudioContext({ sampleRate: 48000 });
  const pitchSrc  = pitchCtx.createMediaStreamSource(micStream);
  const pitchProc = pitchCtx.createScriptProcessor(1024, 1, 1);
  pitchSrc.connect(pitchProc);
  pitchProc.connect(pitchCtx.destination);
  pitchProc.onaudioprocess = (ev) => {
    const samples = ev.inputBuffer.getChannelData(0);
    const f0      = VoiceProfile._autocorrF0(samples);
    if (f0 > 0) {
      lastPitch = f0;
      pitchDisp.textContent = Math.round(f0) + ' Hz';
    }
  };

  try {
    await cvProfile.enroll(micStream, DURATION, (progress) => {
      const elapsed = Math.round(progress * DURATION);
      progressF.style.width = (progress * 100) + '%';
      progressL.textContent = elapsed + 's / ' + DURATION + 's';
    });

    // Enrollment complete
    pitchSrc.disconnect(); pitchProc.disconnect(); pitchCtx.close();
    micStream.getTracks().forEach(t => t.stop());
    progressW.style.display = 'none';

    resultDiv.style.display = 'block';
    document.getElementById('enroll-result-pitch').textContent =
      Math.round(cvProfile.f0Mean) + ' Hz';
    document.getElementById('enroll-result-label').textContent =
      `Your voice: ${cvProfile.profile.f0Min.toFixed(0)}–${cvProfile.profile.f0Max.toFixed(0)} Hz · ${cvProfile.profile.sampleCount} frames`;

    btn.innerHTML  = '✓ Re-enroll';
    btn.disabled   = false;
    instructions.style.display = 'block';

    cvUpdateProfileUI();
    cvUpdateEnrollTab();

  } catch (err) {
    pitchSrc.disconnect(); pitchProc.disconnect(); pitchCtx.close();
    micStream.getTracks().forEach(t => t.stop());
    progressW.style.display   = 'none';
    instructions.style.display = 'block';
    alert('Enrollment failed: ' + err.message);
    btn.innerHTML = '🎙 Start Enrollment';
    btn.disabled  = false;
  }

  cvState.enrolling = false;
}

function cvClearProfile() {
  if (!confirm('Clear your voice profile?')) return;
  cvProfile.clear();
  cvUpdateProfileUI();
  cvUpdateEnrollTab();
}

// ── SIP / Dialer ──────────────────────────────────────────────────────────────

function cvLoadSipSettings() {
  const saved = JSON.parse(localStorage.getItem('cv_sip_config') || '{}');
  if (saved.server)   document.getElementById('sip-server').value   = saved.server;
  if (saved.user)     document.getElementById('sip-user').value     = saved.user;
}

async function cvSipConnect() {
  const server   = document.getElementById('sip-server').value.trim();
  const user     = document.getElementById('sip-user').value.trim();
  const password = document.getElementById('sip-password').value;

  if (!server || !user || !password) {
    alert('Please fill in Server, Agent ID, and Password.');
    return;
  }

  // Save server + user (not password) for convenience
  localStorage.setItem('cv_sip_config', JSON.stringify({ server, user }));

  const btn = document.getElementById('sip-connect-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  cvSetSipStatus('Connecting…');

  // Ensure engine is running before connecting (we need the clean stream)
  if (!cvState.engineRunning) {
    try { await cvStartEngine(); } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Connect';
      alert('Start the noise filter first: ' + err.message);
      return;
    }
  }

  try {
    await cvSip.connect({ server, user, password, displayName: 'Agent ' + user });
    btn.disabled = false;
    btn.style.display = 'none';
    document.getElementById('sip-disconnect-btn').style.display = 'block';
    cvState.sipConnected = true;
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Connect';
    cvSetSipStatus('Failed: ' + err.message);
    console.error('[SIP Connect]', err);
  }
}

function cvSipDisconnect() {
  cvSip.disconnect();
  cvState.sipConnected = false;
  document.getElementById('sip-connect-btn').style.display = 'block';
  document.getElementById('sip-connect-btn').disabled = false;
  document.getElementById('sip-connect-btn').textContent = 'Connect';
  document.getElementById('sip-disconnect-btn').style.display = 'none';
  cvSetSipStatus('Disconnected');
}

function cvOnSipState(state, detail) {
  const labels = {
    disconnected: 'Disconnected',
    connecting:   'Connecting…',
    registered:   '● Registered',
    incoming:     '📞 Incoming call',
    calling:      '📞 Calling…',
    'in-call':    '● In call',
    error:        '✕ ' + (detail || 'Error'),
  };
  cvSetSipStatus(labels[state] || state);

  if (state === 'in-call') {
    cvShowCallOverlay(cvState.dialNumber || detail || 'Unknown');
  } else if (state === 'registered' && cvState.inCall) {
    cvHideCallOverlay();
  }

  // Update header status dot
  if (state === 'in-call' || state === 'calling') {
    document.getElementById('cv-status-dot').className = 'cv-status-dot calling';
  } else if (cvState.engineRunning) {
    document.getElementById('cv-status-dot').className = 'cv-status-dot active';
  }
}

function cvOnIncomingCall(callerNumber) {
  const accept = confirm(`Incoming call from ${callerNumber}\n\nAnswer?`);
  if (accept) {
    cvSip.answer(cvEngine.getCleanStream());
    cvShowCallOverlay(callerNumber);
  } else {
    cvSip.hangup();
  }
}

function cvSetSipStatus(text) {
  document.getElementById('sip-status-text').textContent = text;
}

// ── Dial pad ──────────────────────────────────────────────────────────────────

function cvDialKey(key) {
  cvState.dialNumber += key;
  cvUpdateDialDisplay();
}

function cvDialBackspace() {
  cvState.dialNumber = cvState.dialNumber.slice(0, -1);
  cvUpdateDialDisplay();
}

function cvDialClear() {
  cvState.dialNumber = '';
  cvUpdateDialDisplay();
}

function cvUpdateDialDisplay() {
  const el = document.getElementById('cv-dial-display');
  el.textContent = cvState.dialNumber || ' '; // nbsp for consistent height
}

function cvDialCall() {
  if (!cvState.dialNumber) return alert('Enter a number first.');
  if (!cvState.sipConnected) return alert('Connect to SIP server first (Dialer tab).');
  if (!cvState.engineRunning) return alert('Start the noise filter first (Monitor tab).');

  try {
    cvSip.call(cvState.dialNumber, cvEngine.getCleanStream());
    cvShowCallOverlay(cvState.dialNumber);
  } catch (err) {
    alert('Call failed: ' + err.message);
  }
}

// ── In-call overlay ───────────────────────────────────────────────────────────

function cvShowCallOverlay(number) {
  cvState.inCall = true;
  cvState.callTimerStart = Date.now();

  document.getElementById('call-number').textContent = number;
  document.getElementById('call-status-text').textContent = 'Connecting…';
  document.getElementById('cv-call-overlay').classList.remove('hidden');

  clearInterval(cvState.callTimerInterval);
  cvState.callTimerInterval = setInterval(() => {
    if (!cvState.callTimerStart) return;
    const elapsed = Math.floor((Date.now() - cvState.callTimerStart) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    document.getElementById('call-timer').textContent = mm + ':' + ss;
    document.getElementById('call-status-text').textContent = 'In call';
  }, 1000);
}

function cvHideCallOverlay() {
  cvState.inCall = false;
  cvState.callTimerStart = null;
  clearInterval(cvState.callTimerInterval);
  document.getElementById('cv-call-overlay').classList.add('hidden');
  document.getElementById('call-timer').textContent = '00:00';
}

function cvHangup() {
  cvSip.hangup();
  cvHideCallOverlay();
}

function cvCallMute() {
  cvState.muted = !cvState.muted;
  cvSip.setMuted(cvState.muted);
  const btn = document.getElementById('call-mute-btn');
  btn.textContent = cvState.muted ? '🔇' : '🎤';
  btn.style.background = cvState.muted ? 'var(--red)' : 'var(--bg-card)';
}

function cvCallSpeaker() {
  // On mobile, toggle loudspeaker via AudioContext sink (best-effort)
  // Most browsers don't expose this yet; on iOS/Android native audio routing handles it
  const btn = document.getElementById('call-speaker-btn');
  btn.style.background = btn.style.background.includes('accent') ? 'var(--bg-card)' : 'var(--accent-dim)';
}

// ── Header status ─────────────────────────────────────────────────────────────

function cvSetStatus(label, active, error = false) {
  document.getElementById('cv-status-label').textContent = label;
  const dot = document.getElementById('cv-status-dot');
  dot.className = 'cv-status-dot' + (active ? ' active' : error ? ' error' : '');
}
