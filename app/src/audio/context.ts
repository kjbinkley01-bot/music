import workletSource from './deck-worklet.js?raw';

let ctx: AudioContext | null = null;
let ready: Promise<void> | null = null;
let master: GainNode | null = null;
let limiter: DynamicsCompressorNode | null = null;

/** One shared AudioContext for the whole app, with a master bus and a safety limiter. */
export function audioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    master = ctx.createGain();
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    master.connect(limiter).connect(ctx.destination);
  }
  return ctx;
}

export function masterBus(): GainNode {
  audioContext();
  return master!;
}

/** Post-limiter node: what you hear. Used to tap the master for recording. */
export function masterOut(): AudioNode {
  audioContext();
  return limiter!;
}

export async function ensureAudio(): Promise<AudioContext> {
  const c = audioContext();
  if (!ready) {
    const url = URL.createObjectURL(new Blob([workletSource], { type: 'application/javascript' }));
    ready = c.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  }
  await ready;
  if (c.state === 'suspended') await c.resume();
  return c;
}
