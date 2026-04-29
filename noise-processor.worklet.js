/**
 * ClearVoice — Noise Gate AudioWorklet Processor
 *
 * Runs in the high-priority audio rendering thread (no GC pauses, no DOM access).
 *
 * Pipeline per frame:
 *   input → compute RMS → update adaptive noise floor → SNR gate decision
 *         → F0 pitch detection → voice profile gate → smoothed gain → output
 *         → post stats to main thread every ~200ms
 *
 * Works alongside WebRTC's built-in noiseSuppression constraint for a
 * two-stage suppression pipeline.
 */

class NoiseGateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.strength    = options.processorOptions?.strength ?? 0.8;
    this.voiceProfile = null;

    // Adaptive noise floor — tracks ambient level slowly
    this.noiseFloor  = 0.004;
    this.noiseSmooth = 0.9998; // very slow decay → persistent floor estimate

    // Calibration mode: learn noise floor aggressively for N frames
    this.calibrating         = false;
    this.calibrationFrames   = 0;
    this.calibrationCount    = 0;

    // Gain smoothing prevents audible clicks on gate transitions
    this.currentGain   = 1.0;
    this.gainSmoothOpen  = 0.04;  // fast open  (~2ms at 48kHz/128)
    this.gainSmoothClose = 0.985; // slow close (~12ms)

    // F0 pitch detection accumulator — need ≥1024 samples for 70 Hz min lag
    this.F0_BUF_SIZE    = 1024;
    this.f0Accumulator  = new Float32Array(this.F0_BUF_SIZE);
    this.f0AccPos       = 0;
    this.f0AccFull      = false;
    this.lastF0         = 0;

    // Running stats for reporting
    this.frameCount = 0;
    this.rmsIn      = 0;
    this.rmsOut     = 0;

    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'setStrength':
          this.strength = Math.max(0, Math.min(1, data.value));
          break;
        case 'setProfile':
          this.voiceProfile = data.profile; // {enrolled, f0Mean, f0Std}
          break;
        case 'calibrate':
          this.calibrating       = true;
          this.noiseFloor        = 0.0001; // reset so we learn fresh
          this.calibrationFrames = Math.round((data.duration ?? 2) * 48000 / 128);
          this.calibrationCount  = 0;
          break;
        case 'clearProfile':
          this.voiceProfile = null;
          break;
      }
    };
  }

  process(inputs, outputs) {
    const input  = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output || input.length === 0) return true;

    // ── 1. Frame RMS ─────────────────────────────────────────────────────────
    let sumSq = 0;
    for (let i = 0; i < input.length; i++) sumSq += input[i] * input[i];
    const rms = Math.sqrt(sumSq / input.length);
    this.rmsIn = rms;

    // ── 2. Adaptive noise floor ───────────────────────────────────────────────
    if (this.calibrating) {
      // Aggressive learning during calibration
      this.noiseFloor = this.noiseFloor * 0.97 + rms * 0.03;
      this.calibrationCount++;
      if (this.calibrationCount >= this.calibrationFrames) {
        this.calibrating = false;
        this.port.postMessage({ type: 'calibrationDone', noiseFloor: this.noiseFloor });
      }
    } else {
      // Only update floor when signal is close to noise level (no speech)
      if (rms < this.noiseFloor * 1.8) {
        this.noiseFloor = this.noiseFloor * this.noiseSmooth + rms * (1 - this.noiseSmooth);
      }
    }

    // ── 3. SNR gate ───────────────────────────────────────────────────────────
    const snr            = rms / (this.noiseFloor + 1e-9);
    // threshold: weaker strength → higher threshold → less aggressive gate
    const gateThreshold  = 2.5 + (1.0 - this.strength) * 6.0;
    const voiceDetected  = snr > gateThreshold;

    // ── 4. F0 accumulator + pitch detection ──────────────────────────────────
    let remaining = input.length;
    let inputOffset = 0;
    while (remaining > 0) {
      const space = this.F0_BUF_SIZE - this.f0AccPos;
      const copy  = Math.min(remaining, space);
      this.f0Accumulator.set(input.subarray(inputOffset, inputOffset + copy), this.f0AccPos);
      this.f0AccPos += copy;
      inputOffset   += copy;
      remaining     -= copy;

      if (this.f0AccPos >= this.F0_BUF_SIZE) {
        this.f0AccFull = true;
        if (rms > this.noiseFloor * 2.5) {
          this.lastF0 = this._detectF0(this.f0Accumulator);
        }
        this.f0AccPos = 0; // reset circular buffer
      }
    }

    // ── 5. Voice profile gate ─────────────────────────────────────────────────
    let profileGate = 1.0;
    if (
      this.voiceProfile?.enrolled &&
      voiceDetected &&
      this.lastF0 > 0
    ) {
      const { f0Mean, f0Std } = this.voiceProfile;
      const distance = Math.abs(this.lastF0 - f0Mean) / (f0Std + 12);
      if (distance > 2.0) {
        // Pitch doesn't match enrolled user → attenuate this voice
        profileGate = Math.max(0.08, 1.0 - this.strength * 0.88);
      }
    }

    // ── 6. Target gain ────────────────────────────────────────────────────────
    let targetGain;
    if (voiceDetected) {
      targetGain = profileGate;
    } else {
      // Below gate: residual level inversely proportional to strength
      targetGain = Math.max(0.02, 1.0 - this.strength * 0.96) * profileGate;
    }

    // ── 7. Smoothed gain application ─────────────────────────────────────────
    for (let i = 0; i < output.length; i++) {
      const smoothFactor = targetGain > this.currentGain
        ? this.gainSmoothOpen
        : this.gainSmoothClose;
      this.currentGain += (targetGain - this.currentGain) * smoothFactor;
      output[i] = input[i] * this.currentGain;
    }
    this.rmsOut = rms * this.currentGain;

    // ── 8. Stats reporting (~200ms cadence at 128-sample frames, 48kHz) ──────
    this.frameCount++;
    if (this.frameCount % 75 === 0) {
      this.port.postMessage({
        type: 'stats',
        rmsIn:        this.rmsIn,
        rmsOut:       this.rmsOut,
        noiseFloor:   this.noiseFloor,
        gain:         this.currentGain,
        f0:           this.lastF0,
        voiceDetected,
        strength:     this.strength,
      });
    }

    return true;
  }

  /**
   * Autocorrelation pitch (F0) detector for 70–500 Hz range.
   * Normalized per-lag to avoid amplitude bias.
   *
   * @param {Float32Array} samples - 1024 audio samples at 48 kHz
   * @returns {number} detected F0 in Hz, or 0 if none found
   */
  _detectF0(samples) {
    const SR     = 48000;
    const minLag = Math.floor(SR / 500); // 96  → 500 Hz upper bound
    const maxLag = Math.floor(SR / 70);  // 685 → 70  Hz lower bound
    const len    = samples.length;

    // Skip if signal is too quiet
    let energy = 0;
    for (let i = 0; i < len; i++) energy += samples[i] * samples[i];
    if (energy / len < 0.00005) return 0;

    let maxCorr = -Infinity;
    let bestLag = -1;

    for (let lag = minLag; lag <= Math.min(maxLag, len - 1); lag++) {
      let corr = 0;
      const limit = len - lag;
      for (let i = 0; i < limit; i++) {
        corr += samples[i] * samples[i + lag];
      }
      // Normalize by overlap length (removes amplitude bias across lags)
      corr /= limit;
      if (corr > maxCorr) {
        maxCorr = corr;
        bestLag = lag;
      }
    }

    return bestLag > 0 ? SR / bestLag : 0;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
