/**
 * ClearVoice — SIP Client (JsSIP wrapper)
 *
 * Provides a simple softphone interface for VICIdial/Asterisk via
 * WebRTC/WebSocket SIP.  Accepts a clean MediaStream from AudioEngine
 * and replaces the default microphone track on the peer connection,
 * ensuring the far end (the customer) hears noise-cancelled audio.
 *
 * VICIdial WebSocket SIP endpoint (Asterisk + chan_pjsip):
 *   wss://<host>:8089/ws
 *
 * Usage:
 *   const sip = new SipClient();
 *   sip.onStateChange(({state, detail}) => updateCallUI(state));
 *   await sip.connect({ server: 'limitless.thevoyagenetworks.com',
 *                        user: '8022', password: 'agentpass' });
 *   sip.call('9999', audioEngine.getCleanStream());
 *   // ... later ...
 *   sip.hangup();
 *   sip.disconnect();
 *
 * States: disconnected → connecting → registered → calling → in-call → registered
 */

class SipClient {
  static STATES = Object.freeze({
    DISCONNECTED: 'disconnected',
    CONNECTING:   'connecting',
    REGISTERED:   'registered',
    INCOMING:     'incoming',
    CALLING:      'calling',
    IN_CALL:      'in-call',
    ERROR:        'error',
  });

  constructor() {
    this._ua              = null;
    this._session         = null;
    this._config          = null;
    this._stateCallback   = null;
    this._incomingCallback = null;
    this._remoteAudio     = null;
    this.state            = SipClient.STATES.DISCONNECTED;
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  /**
   * Register with the SIP server.
   *
   * @param {{server: string, user: string, password: string, displayName?: string}} config
   * @returns {Promise} resolves when registered, rejects on failure
   */
  connect(config) {
    return new Promise((resolve, reject) => {
      if (typeof JsSIP === 'undefined') {
        return reject(new Error('JsSIP library not loaded. Check www/lib/jssip.bundle.js.'));
      }
      if (this._ua) this.disconnect();

      this._config = config;

      // Normalise server URL → wss://host:8089/ws
      const host = config.server
        .replace(/^wss?:\/\//, '')
        .replace(/\/.*$/, '')
        .split(':')[0];

      const wsUri = config.server.startsWith('ws')
        ? config.server
        : `wss://${host}:8089/ws`;

      const sipDomain = host;
      const socket    = new JsSIP.WebSocketInterface(wsUri);

      this._ua = new JsSIP.UA({
        sockets:                         [socket],
        uri:                             `sip:${config.user}@${sipDomain}`,
        password:                        config.password,
        display_name:                    config.displayName || `Agent ${config.user}`,
        register:                        true,
        register_expires:                300,
        session_timers:                  false,
        connection_recovery_min_interval: 2,
        connection_recovery_max_interval: 30,
        log: { level: 'warn' },
      });

      this._ua.on('connected',     () => this._setState(SipClient.STATES.CONNECTING));
      this._ua.on('disconnected',  () => this._setState(SipClient.STATES.DISCONNECTED));
      this._ua.on('registered',    () => { this._setState(SipClient.STATES.REGISTERED); resolve(); });
      this._ua.on('unregistered',  () => this._setState(SipClient.STATES.DISCONNECTED));

      this._ua.on('registrationFailed', (e) => {
        const msg = `Registration failed: ${e.cause || 'unknown'}`;
        this._setState(SipClient.STATES.ERROR, msg);
        reject(new Error(msg));
      });

      this._ua.on('newRTCSession', (e) => this._onNewSession(e));

      this._setState(SipClient.STATES.CONNECTING);
      this._ua.start();

      // Timeout if registration takes too long
      setTimeout(() => {
        if (this.state === SipClient.STATES.CONNECTING) {
          reject(new Error('SIP registration timed out. Check server address and credentials.'));
        }
      }, 15000);
    });
  }

  /**
   * Unregister and close the WebSocket connection.
   */
  disconnect() {
    this.hangup();
    if (this._ua) {
      try { this._ua.stop(); } catch (_) {}
      this._ua = null;
    }
    this._setState(SipClient.STATES.DISCONNECTED);
  }

  // ── Calls ──────────────────────────────────────────────────────────────────

  /**
   * Place an outbound call.
   *
   * @param {string}      target      - phone number, extension, or full SIP URI
   * @param {MediaStream} audioStream - clean stream from AudioEngine
   */
  call(target, audioStream) {
    if (!this._ua || this.state !== SipClient.STATES.REGISTERED) {
      throw new Error(`Cannot call: SIP state is "${this.state}". Must be "registered".`);
    }

    const sipUri = this._toSipUri(target);
    const options = {
      mediaConstraints: { audio: true, video: false },
      pcConfig: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      },
      rtcConstraints: { optional: [{ DtlsSrtpKeyAgreement: 'true' }] },
    };

    this._session = this._ua.call(sipUri, options);
    this._attachSessionHandlers(this._session, audioStream);
    this._setState(SipClient.STATES.CALLING);
  }

  /**
   * Accept an incoming call.
   * @param {MediaStream} audioStream - clean stream from AudioEngine
   */
  answer(audioStream) {
    if (!this._session) return;
    this._session.answer({ mediaConstraints: { audio: true, video: false } });
    this._attachSessionHandlers(this._session, audioStream);
    this._setState(SipClient.STATES.IN_CALL);
  }

  /**
   * Hang up / decline the current call.
   */
  hangup() {
    if (this._session) {
      try { this._session.terminate(); } catch (_) {}
      this._session = null;
    }
    if (this._remoteAudio) {
      this._remoteAudio.srcObject = null;
      this._remoteAudio = null;
    }
    if ([SipClient.STATES.CALLING, SipClient.STATES.IN_CALL, SipClient.STATES.INCOMING]
        .includes(this.state)) {
      this._setState(SipClient.STATES.REGISTERED);
    }
  }

  /**
   * Mute / unmute outbound audio track.
   * @param {boolean} muted
   */
  setMuted(muted) {
    if (!this._session?.connection) return;
    this._session.connection.getSenders()
      .filter(s => s.track?.kind === 'audio')
      .forEach(s => { s.track.enabled = !muted; });
  }

  // ── Events ─────────────────────────────────────────────────────────────────

  /**
   * Register state-change handler.
   * Callback receives: {state: string, detail?: string}
   */
  onStateChange(cb) { this._stateCallback = cb; }

  /**
   * Register handler for incoming calls.
   * Callback receives: {callerNumber: string, session: JsSIPSession}
   */
  onIncoming(cb) { this._incomingCallback = cb; }

  // ── Private ────────────────────────────────────────────────────────────────

  _setState(state, detail = null) {
    this.state = state;
    this._stateCallback?.({ state, detail });
  }

  _toSipUri(target) {
    if (target.includes('@')) return target.startsWith('sip:') ? target : `sip:${target}`;
    const domain = this._config.server
      .replace(/^wss?:\/\//, '').replace(/\/.*$/, '').split(':')[0];
    return `sip:${target}@${domain}`;
  }

  _onNewSession({ session, originator }) {
    if (originator === 'remote') {
      this._session = session;
      const callerNumber = session.remote_identity?.uri?.user || 'Unknown';
      this._setState(SipClient.STATES.INCOMING, callerNumber);
      this._incomingCallback?.({ callerNumber, session });
    }
  }

  _attachSessionHandlers(session, audioStream) {
    session.on('progress', () => this._setState(SipClient.STATES.CALLING));

    session.on('confirmed', async () => {
      this._setState(SipClient.STATES.IN_CALL);

      // Inject the clean (noise-cancelled) audio track
      if (audioStream && session.connection) {
        const senders     = session.connection.getSenders();
        const audioSender = senders.find(s => s.track?.kind === 'audio');
        const cleanTrack  = audioStream.getAudioTracks()[0];
        if (audioSender && cleanTrack) {
          try {
            await audioSender.replaceTrack(cleanTrack);
            console.log('[SipClient] Clean track injected into call');
          } catch (err) {
            console.warn('[SipClient] replaceTrack failed:', err);
          }
        }
      }
    });

    session.on('ended',   () => { this._session = null; this._setState(SipClient.STATES.REGISTERED); });
    session.on('failed',  (e) => {
      console.warn('[SipClient] Call failed:', e.cause);
      this._session = null;
      this._setState(SipClient.STATES.REGISTERED);
    });

    // Route remote (far-end) audio to speaker
    session.on('peerconnection', ({ peerconnection }) => {
      peerconnection.addEventListener('track', ({ track, streams }) => {
        if (track.kind !== 'audio') return;
        if (!this._remoteAudio) {
          this._remoteAudio = new Audio();
          this._remoteAudio.autoplay = true;
        }
        this._remoteAudio.srcObject = streams[0] ?? new MediaStream([track]);
        this._remoteAudio.play().catch(console.warn);
      });
    });
  }
}
