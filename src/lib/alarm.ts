/**
 * Alarm engine — synthesised with the Web Audio API rather than a bundled
 * audio file, so there is no licensing question and no extra network asset.
 *
 * Reality check (also documented in README): a web page can only play sound
 * while it is alive. Browsers suspend audio in closed tabs, and autoplay
 * policies require a prior user gesture. We therefore start the AudioContext
 * on an explicit user interaction (test alarm / starting the app's alarm), and
 * never claim a "guaranteed loud alarm" once the browser is closed.
 */
export type AlarmTone = 'pulse' | 'chime' | 'beacon';

const PATTERNS: Record<AlarmTone, { freqs: number[]; on: number; off: number; gain: number }> = {
  pulse: { freqs: [880, 660], on: 0.18, off: 0.22, gain: 0.5 },
  chime: { freqs: [523.25, 659.25, 783.99], on: 0.22, off: 0.5, gain: 0.42 },
  beacon: { freqs: [440, 880], on: 0.4, off: 0.3, gain: 0.38 },
};

export class AlarmPlayer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: number | null = null;
  private step = 0;
  private playing = false;

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.6;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Must be called from a user gesture the first time. */
  async unlock() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  setVolume(volume: number) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, volume));
  }

  private beep(freqs: number[], on: number, gain: number) {
    const ctx = this.ensureContext();
    if (!this.master) return;
    const now = ctx.currentTime;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const start = now + i * (on + 0.04);
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(gain, start + 0.02);
      env.gain.exponentialRampToValueAtTime(0.0001, start + on);
      osc.connect(env).connect(this.master!);
      osc.start(start);
      osc.stop(start + on + 0.02);
    });
  }

  async start(tone: AlarmTone = 'pulse', volume = 0.6) {
    await this.unlock();
    this.setVolume(volume);
    if (this.playing) return;
    this.playing = true;
    this.step = 0;
    const pattern = PATTERNS[tone];
    const tick = () => {
      if (!this.playing) return;
      // Gentle 3-beep bursts, then a longer silence — noticeable, not hostile.
      if (this.step % 6 < 3) this.beep(pattern.freqs, pattern.on, pattern.gain);
      this.step += 1;
    };
    tick();
    this.timer = window.setInterval(tick, (pattern.on + pattern.off) * 1000);
  }

  stop() {
    this.playing = false;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
  }

  async testPlay(tone: AlarmTone = 'pulse', volume = 0.6) {
    await this.start(tone, volume);
    window.setTimeout(() => this.stop(), 2600);
  }

  get isPlaying() {
    return this.playing;
  }
}

export const alarmPlayer = new AlarmPlayer();
