/**
 * ClearVoice — Voice Profile
 *
 * Handles voice enrollment: records the user speaking for N seconds,
 * extracts their fundamental frequency (F0/pitch) distribution, and
 * stores it so the NoiseGateProcessor can distinguish them from other
 * speakers in the room.
 *
 * Algorithm:
 *   1. Record N seconds of the user speaking
 *   2. Split into 1024-sample frames (21.3ms at 48kHz)
 *   3. Run autocorrelation pitch detection on voiced frames (skip silence)
 *   4. Compute trimmed mean and std of collected F0 values
 *   5. Persist to localStorage for persistence across sessions
 *
 * Usage:
 *   const vp = new VoiceProfile();
 *   vp.load();                         // restore from localStorage if available
 *   await vp.enroll(micStream, 10, (p) => updateProgressBar(p));
 *   engine.setVoiceProfile(vp.profile); // pass to AudioEngine
 */

class VoiceProfile {
  static SAMPLE_RATE  = 48000;
  static FRAME_SIZE   = 1024; // ~21.3ms — enough for 70 Hz min F0 detection
  static STORAGE_KEY  = 'clearvoice_voice_profile_v2';

  constructor() {
    this.profile = VoiceProfile._emptyProfile();
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get enrolled()  { return this.profile.enrolled; }
  get f0Mean()    { return this.profile.f0Mean; }
  get f0Std()     { return this.profile.f0Std; }
  get summary()   {
    if (!this.profile.enrolled) return 'Not enrolled';
    const date = this.profile.enrolledAt
      ? new Date(this.profile.enrolledAt).toLocaleDateString()
      : '';
    return `${this.profile.f0Mean.toFixed(0)} Hz ±${this.profile.f0Std.toFixed(0)} Hz${date ? '  ·  ' + date : ''}`;
  }

  /**
   * Record mic audio and compute voice profile.
   *
   * @param {MediaStream} stream       - active microphone MediaStream
   * @param {number}      durationSec  - recording length in seconds (default 10)
   * @param {Function}    onProgress   - callback(0.0–1.0) for UI progress bar
   * @returns {Promise<object>}         resolved with profile when complete
   */
  async enroll(stream, durationSec = 10, onProgress = null) {
    return new Promise((resolve, reject) => {
      let ctx;
      try {
        ctx = new AudioContext({ sampleRate: VoiceProfile.SAMPLE_RATE });
      } catch (err) {
        return reject(new Error('AudioContext unavailable: ' + err.message));
      }

      const source    = ctx.createMediaStreamSource(stream);
      // ScriptProcessor is deprecated but is the only way to get raw samples
      // synchronously without an AudioWorklet (which can't be re-used here).
      const processor = ctx.createScriptProcessor(VoiceProfile.FRAME_SIZE, 1, 1);

      const f0Values  = [];
      const startTime = ctx.currentTime;
      const endTime   = startTime + durationSec;
      let   finished  = false;

      const cleanup = () => {
        try { source.disconnect(); } catch (_) {}
        try { processor.disconnect(); } catch (_) {}
        ctx.close().catch(() => {});
      };

      processor.onaudioprocess = (event) => {
        if (finished) return;

        const samples = event.inputBuffer.getChannelData(0);
        const elapsed = ctx.currentTime - startTime;
        const progress = Math.min(elapsed / durationSec, 1.0);

        onProgress?.(progress);

        // Skip silent frames (below -50 dB)
        let energy = 0;
        for (let i = 0; i < samples.length; i++) energy += samples[i] * samples[i];
        const rms = Math.sqrt(energy / samples.length);

        if (rms > 0.003) {
          const f0 = VoiceProfile._autocorrF0(samples);
          if (f0 > 0) f0Values.push(f0);
        }

        if (ctx.currentTime >= endTime) {
          finished = true;
          cleanup();

          if (f0Values.length < 8) {
            return reject(new Error(
              'Not enough voiced speech detected. Please speak continuously during enrollment.'
            ));
          }

          this._buildProfile(f0Values);
          this.save();
          resolve({ ...this.profile });
        }
      };

      // Connect: source → processor → destination (destination needed for process to fire)
      source.connect(processor);
      processor.connect(ctx.destination);

      // Safety timeout
      setTimeout(() => {
        if (!finished) {
          finished = true;
          cleanup();
          reject(new Error('Enrollment timed out'));
        }
      }, (durationSec + 5) * 1000);
    });
  }

  /**
   * Persist the current profile to localStorage.
   */
  save() {
    try {
      localStorage.setItem(VoiceProfile.STORAGE_KEY, JSON.stringify(this.profile));
    } catch (e) {
      console.warn('[VoiceProfile] save failed:', e);
    }
  }

  /**
   * Restore profile from localStorage.
   * @returns {boolean} true if a valid enrolled profile was found
   */
  load() {
    try {
      const raw = localStorage.getItem(VoiceProfile.STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (parsed?.enrolled) {
        this.profile = { ...VoiceProfile._emptyProfile(), ...parsed };
        return true;
      }
    } catch (e) {
      console.warn('[VoiceProfile] load failed:', e);
    }
    return false;
  }

  /**
   * Erase the stored profile.
   */
  clear() {
    this.profile = VoiceProfile._emptyProfile();
    localStorage.removeItem(VoiceProfile.STORAGE_KEY);
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _buildProfile(f0Values) {
    // Sort and trim top/bottom 10% to remove outliers
    const sorted     = [...f0Values].sort((a, b) => a - b);
    const trimStart  = Math.floor(sorted.length * 0.10);
    const trimEnd    = Math.ceil(sorted.length  * 0.90);
    const trimmed    = sorted.slice(trimStart, trimEnd);

    const mean = trimmed.reduce((acc, v) => acc + v, 0) / trimmed.length;
    const variance = trimmed.reduce((acc, v) => acc + (v - mean) ** 2, 0) / trimmed.length;
    const std  = Math.sqrt(variance);

    this.profile = {
      enrolled:   true,
      f0Mean:     Math.round(mean  * 10) / 10,
      f0Std:      Math.round(std   * 10) / 10,
      f0Min:      Math.round(trimmed[0] * 10) / 10,
      f0Max:      Math.round(trimmed[trimmed.length - 1] * 10) / 10,
      sampleCount: f0Values.length,
      enrolledAt:  new Date().toISOString(),
    };
  }

  /**
   * Autocorrelation pitch detection for a single frame.
   * Detects F0 in range 70–500 Hz at 48 kHz.
   *
   * @param {Float32Array} samples
   * @returns {number} F0 in Hz, or 0 if pitch not detected
   */
  static _autocorrF0(samples) {
    const SR     = VoiceProfile.SAMPLE_RATE;
    const minLag = Math.floor(SR / 500); // 96
    const maxLag = Math.floor(SR / 70);  // 685
    const len    = samples.length;

    if (len < maxLag + 1) return 0;

    let maxCorr = -Infinity;
    let bestLag = -1;

    for (let lag = minLag; lag <= Math.min(maxLag, len - 1); lag++) {
      let corr  = 0;
      const lim = len - lag;
      for (let i = 0; i < lim; i++) corr += samples[i] * samples[i + lag];
      corr /= lim; // normalize per lag length
      if (corr > maxCorr) { maxCorr = corr; bestLag = lag; }
    }

    return bestLag > 0 ? SR / bestLag : 0;
  }

  static _emptyProfile() {
    return {
      enrolled:    false,
      f0Mean:      0,
      f0Std:       0,
      f0Min:       0,
      f0Max:       0,
      sampleCount: 0,
      enrolledAt:  null,
    };
  }
}
