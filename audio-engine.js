/**
 * ClearVoice — Audio Engine
 *
 * Owns the entire Web Audio API pipeline:
 *
 *   Mic (getUserMedia)
 *     → MediaStreamSource
 *     → AnalyserNode (raw level meter tap)
 *     → AudioWorkletNode 'noise-gate-processor'  (adaptive gate + voice profile)
 *     → MediaStreamDestination  (clean stream for SIP / monitoring)
 *
 * WebRTC constraints (noiseSuppression, echoCancellation, autoGainControl)
 * are enabled on the getUserMedia call, providing a first suppression stage
 * before our custom gate runs.
 *
 * Usage:
 *   const engine = new AudioEngine();
 *   await engine.start();
 *   engine.onStats(stats => updateMeters(stats));
 *   const cleanStream = engine.getCleanStream(); // feed to SipClient
 *   engine.setVoiceProfile(voiceProfile.profile);
 *   await engine.stop();
 */

class AudioEngine {
  constructor() {
    this._ctx             = null;
    this._workletNode     = null;
    this._sourceNode      = null;
    this._analyserIn      = null;   // measures raw (pre-gate) level
    this._analyserOut     = null;   // measures clean (post-gate) level
    this._destinationNode = null;
    this._micStream       = null;
    this._cleanStream     = null;

    this._statsCallbacks  = [];
    this._errorCallback   = null;
    this._running         = false;

    // Persisted settings applied when engine (re)starts
    this._strength        = 0.8;
    this._deviceId        = undefined;
    this._pendingProfile  = null;

    // Cached stats for external polling
    this.lastStats = {
      rmsIn: 0, rmsOut: 0, noiseFloor: 0,
      gain: 1, f0: 0, voiceDetected: false,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Open the microphone, load the AudioWorklet, and start processing.
   * @param {string} [deviceId] - specific microphone device ID (optional)
   */
  async start(deviceId = undefined) {
    if (this._running) await this.stop();
    this._deviceId = deviceId;

    // Stage 1: Request mic with WebRTC's built-in suppressions
    const constraints = {
      audio: {
        noiseSuppression:  true,
        echoCancellation:  true,
        autoGainControl:   true,
        channelCount:      1,
        sampleRate:        { ideal: 48000 },
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    };

    try {
      this._micStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      throw new Error(
        err.name === 'NotAllowedError'
          ? 'Microphone access denied. Please allow mic permission and try again.'
          : `Could not open microphone: ${err.message}`
      );
    }

    // Stage 2: AudioContext
    this._ctx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate:    48000,
      latencyHint:   'interactive',
    });

    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    // Stage 3: Load AudioWorklet
    try {
      await this._ctx.audioWorklet.addModule('./noise-processor.worklet.js');
    } catch (err) {
      throw new Error(`Failed to load noise processor: ${err.message}`);
    }

    // Stage 4: Build node graph
    this._sourceNode = this._ctx.createMediaStreamSource(this._micStream);

    // Raw level analyser (before gate)
    this._analyserIn = this._ctx.createAnalyser();
    this._analyserIn.fftSize = 256;
    this._analyserIn.smoothingTimeConstant = 0.7;

    // Clean level analyser (after gate)
    this._analyserOut = this._ctx.createAnalyser();
    this._analyserOut.fftSize = 256;
    this._analyserOut.smoothingTimeConstant = 0.7;

    // WorkletNode
    this._workletNode = new AudioWorkletNode(this._ctx, 'noise-gate-processor', {
      processorOptions: { strength: this._strength },
      channelCount:          1,
      channelCountMode:      'explicit',
      channelInterpretation: 'speakers',
      numberOfInputs:        1,
      numberOfOutputs:       1,
      outputChannelCount:    [1],
    });

    this._workletNode.port.onmessage = ({ data }) => {
      if (data.type === 'stats') {
        Object.assign(this.lastStats, data);
        this._statsCallbacks.forEach(cb => cb(data));
      } else if (data.type === 'calibrationDone') {
        this._calibrationResolve?.();
        this._calibrationResolve = null;
        this._calibrationReject  = null;
      }
    };

    this._workletNode.onprocessorerror = (err) => {
      console.error('[AudioEngine] Worklet error:', err);
      this._errorCallback?.(err);
    };

    // Clean output stream
    this._destinationNode = this._ctx.createMediaStreamDestination();

    // Wire up: source → analyserIn → worklet → analyserOut → destination
    this._sourceNode.connect(this._analyserIn);
    this._analyserIn.connect(this._workletNode);
    this._workletNode.connect(this._analyserOut);
    this._analyserOut.connect(this._destinationNode);

    this._cleanStream = this._destinationNode.stream;

    // Apply pending settings
    if (this._pendingProfile) {
      this._sendProfile(this._pendingProfile);
      this._pendingProfile = null;
    }
    this._sendStrength(this._strength);

    this._running = true;
    console.log('[AudioEngine] Started — ctx sampleRate:', this._ctx.sampleRate);
  }

  /**
   * Tear down the audio pipeline and release all resources.
   */
  async stop() {
    const nodes = [
      this._sourceNode, this._analyserIn,
      this._workletNode, this._analyserOut, this._destinationNode,
    ];
    nodes.forEach(n => { try { n?.disconnect(); } catch (_) {} });

    if (this._micStream) {
      this._micStream.getTracks().forEach(t => t.stop());
      this._micStream = null;
    }
    if (this._ctx) {
      try { await this._ctx.close(); } catch (_) {}
      this._ctx = null;
    }

    this._sourceNode = this._analyserIn = this._workletNode =
      this._analyserOut = this._destinationNode = this._cleanStream = null;
    this._running = false;
    console.log('[AudioEngine] Stopped');
  }

  // ── Configuration ──────────────────────────────────────────────────────────

  /**
   * Set noise reduction strength.
   * @param {number} value - 0 (off) to 1 (maximum)
   */
  setStrength(value) {
    this._strength = Math.max(0, Math.min(1, value));
    if (this._running) this._sendStrength(this._strength);
  }

  /**
   * Provide a voice profile for speaker-aware gating.
   * @param {object} profile - from VoiceProfile.profile
   */
  setVoiceProfile(profile) {
    if (this._running && this._workletNode) {
      this._sendProfile(profile);
    } else {
      this._pendingProfile = profile; // applied on next start()
    }
  }

  /**
   * Calibrate the noise floor from ambient environment.
   * Call this when the agent is in their workspace (before speaking).
   * @param {number} durationSec - how long to sample (default 2s)
   */
  calibrate(durationSec = 2) {
    return new Promise((resolve, reject) => {
      if (!this._running) return reject(new Error('Engine not running'));
      this._calibrationResolve = resolve;
      this._calibrationReject  = reject;
      this._workletNode.port.postMessage({ type: 'calibrate', duration: durationSec });
      setTimeout(() => {
        if (this._calibrationReject) {
          this._calibrationReject(new Error('Calibration timed out'));
          this._calibrationResolve = this._calibrationReject = null;
        }
      }, (durationSec + 3) * 1000);
    });
  }

  // ── Monitoring ─────────────────────────────────────────────────────────────

  /**
   * Register a stats callback (receives worklet messages every ~200ms).
   * Returns an unsubscribe function.
   */
  onStats(callback) {
    this._statsCallbacks.push(callback);
    return () => { this._statsCallbacks = this._statsCallbacks.filter(c => c !== callback); };
  }

  /**
   * Register an error callback for worklet errors.
   */
  onError(callback) { this._errorCallback = callback; }

  /**
   * Read the current raw (pre-gate) audio level as a 0–1 value.
   * Uses AnalyserNode for sub-callback-period resolution.
   */
  getRawLevel() {
    if (!this._analyserIn) return 0;
    const buf = new Uint8Array(this._analyserIn.frequencyBinCount);
    this._analyserIn.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  /**
   * Read the current clean (post-gate) audio level as a 0–1 value.
   */
  getCleanLevel() {
    if (!this._analyserOut) return 0;
    const buf = new Uint8Array(this._analyserOut.frequencyBinCount);
    this._analyserOut.getByteTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > peak) peak = v;
    }
    return peak;
  }

  /**
   * Returns the clean MediaStream — feed this to JsSIP for noise-free calls.
   */
  getCleanStream() { return this._cleanStream; }

  get running() { return this._running; }

  // ── Device enumeration ─────────────────────────────────────────────────────

  /**
   * List available microphone devices.
   * @returns {Promise<Array<{deviceId, label}>>}
   */
  static async getInputDevices() {
    try {
      // Must request mic permission once before labels are available
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    } catch (_) {}

    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(d => d.kind === 'audioinput')
      .map(d => ({ deviceId: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 6)}` }));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _sendStrength(value) {
    this._workletNode?.port.postMessage({ type: 'setStrength', value });
  }

  _sendProfile(profile) {
    if (profile?.enrolled) {
      this._workletNode?.port.postMessage({
        type: 'setProfile',
        profile: { enrolled: true, f0Mean: profile.f0Mean, f0Std: profile.f0Std },
      });
    } else {
      this._workletNode?.port.postMessage({ type: 'clearProfile' });
    }
  }
}
