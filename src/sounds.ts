/**
 * Small UI sounds, synthesised with Web Audio so there's no file to load. The
 * context is made on first use, which is always inside a click, so browsers
 * allow it to play.
 */
let ctx: AudioContext | null = null;

/** A short rising two-note chime for ticking a task off. */
export function playDone() {
    try {
        ctx ??= new AudioContext();
        const now = ctx.currentTime;
        // G5 then D6: a bright perfect fifth, the second note a beat later.
        for (const [freq, at] of [
            [784, 0],
            [1175, 0.075],
        ]) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = "sine";
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0, now + at);
            gain.gain.linearRampToValueAtTime(0.16, now + at + 0.008);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.4);
            osc.connect(gain).connect(ctx.destination);
            osc.start(now + at);
            osc.stop(now + at + 0.42);
        }
    } catch {
        // No Web Audio (or it's blocked): finishing a task still works, just quietly.
    }
}
