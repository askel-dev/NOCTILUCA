// The flock's voice: a dark wind bed with struck pentatonic bells on cohesion.
// Ported from the FLOCK preset in sound-sandbox.html, which is where to go to
// re-audition any of these numbers with sliders instead of a live flock.
//
// The one hard rule: there is no independent clock. Tone.Transport is never
// started, there are no loops, sequences or LFOs, and nothing makes a sound
// that the simulation did not cause. Every parameter here is a smoothed ramp
// driven by FlockStats, and every bell traces to a cohesion event. A still
// flock is a silent one.

const SOUND = {
    master: 0.8,
    masterCutoff: 5000,
    reverbDecay: 6.5,
    reverbSend: 0.38,
    windLevel: 0.72,
    bellLevel: 1.0,
    maxVoices: 12,
    // Ramp time for every mapped parameter. Long enough to keep the flock from
    // zippering, short enough that a change still reads as caused by what you
    // just watched happen.
    smoothing: 0.18,
    // The wind's cutoff sweep, in Hz and octaves above it. The ceiling of about
    // 1.9 kHz is where the top end starts turning to hiss rather than air.
    //
    // This used to ride energy through a 0.30 cap, which was right in the
    // sandbox where energy swept its whole range. Against the live sim energy
    // sits at 0.89, so the cap bit permanently and the cutoff never moved off
    // 1705 Hz — a fixed spectrum, which is what "sounds like white noise"
    // means. It rides density now, the one continuous channel with real travel
    // (0.129/s against energy's 0.058), plus panic so poking the flock opens it.
    windCutoffBase: 350,
    windCutoffOctaves: 2.45,
    // How far the wind steps back under a bell, as a fraction of its level.
    // 0.28 is about -2.8 dB. Zero for a plain sum.
    duckDepth: 0.28,
    // Panic is the sharpest signal the sim has. A multiplier on amplitude, not
    // an addition to energy: energy already sits near 0.9 in normal flight, so
    // adding into it would clip the surge away entirely. Not applied to cutoff,
    // so a scared flock surges without getting shrill.
    panicLift: 0.55,
    // How much of the wind's level is always there regardless of the flock.
    // An ambient bed that drops out is worse than one that does not move.
    windFloor: 0.45,
    // The bed barely moves with the centroid; the bells follow it properly.
    // Panning the ambience full-range made the whole soundscape slosh every
    // time the flock wrapped around the canvas.
    windPanScale: 0.28,
    bellPanScale: 0.75,
};

const PENTATONIC = [
    'A2', 'C3', 'D3', 'E3', 'G3', 'A3', 'C4',
    'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5',
];

class FlockSound {
    constructor() {
        this.running = false;
        this.muted = false;
        this.starting = false;
        this.nodes = null;
        this.activeBells = 0;
        this.duckTimer = null;
    }

    // Must be called from a user gesture — browsers will not start an
    // AudioContext without one. Safe to call repeatedly.
    async start() {
        if (this.running || this.starting) return;
        if (typeof Tone === 'undefined') return; // offline: the sketch still runs
        this.starting = true;
        try {
            await Tone.start();
            // The default 0.1 s lookahead puts a tenth of a second between the
            // flock doing something and the sound moving, which is enough to
            // break the causal link the whole design rests on.
            Tone.getContext().lookAhead = 0.03;
            this.nodes = await this._build();
            this.running = true;
        } catch (err) {
            console.warn('flock audio failed to start:', err);
        } finally {
            this.starting = false;
        }
    }

    async _build() {
        const limiter = new Tone.Limiter(-2).toDestination();
        const masterGain = new Tone.Gain(SOUND.master).connect(limiter);
        const masterFilter = new Tone.Filter({
            type: 'lowpass',
            frequency: SOUND.masterCutoff,
            rolloff: -12,
        }).connect(masterGain);

        const reverb = new Tone.Reverb({ decay: SOUND.reverbDecay, preDelay: 0.06, wet: 1 });
        await reverb.generate();
        reverb.connect(masterFilter); // the tail gets the master lowpass too
        const reverbSend = new Tone.Gain(SOUND.reverbSend).connect(reverb);

        // Two panners, not one. The wind is the environment and stays put; the
        // bells are the flock's voice and ring from where it is.
        const windPan = new Tone.Panner(0);
        const bellPan = new Tone.Panner(0);
        for (const p of [windPan, bellPan]) {
            p.connect(masterFilter);
            p.connect(reverbSend); // send taken pre-filter, so no cycle
        }

        const windBus = new Tone.Gain(0).connect(windPan);
        const bellBus = new Tone.Gain(0).connect(bellPan);

        // --- wind: broad, dark, wide, and never resonant enough to whistle ---
        const wAmp = new Tone.Gain(0).connect(windBus);
        const wPanL = new Tone.Panner(-0.62).connect(wAmp);
        const wPanR = new Tone.Panner(0.62).connect(wAmp);
        const wAirL = new Tone.Filter({ type: 'lowpass', frequency: 300, rolloff: -24, Q: 0.4 })
            .connect(wPanL);
        const wAirR = new Tone.Filter({ type: 'lowpass', frequency: 300, rolloff: -24, Q: 0.4 })
            .connect(wPanR);
        const wHPL = new Tone.Filter({ type: 'highpass', frequency: 165, rolloff: -12 }).connect(wAirL);
        const wHPR = new Tone.Filter({ type: 'highpass', frequency: 165, rolloff: -12 }).connect(wAirR);
        // Tone.Noise seeks to a random offset in its buffer on start(), so two
        // pink instances are genuinely decorrelated rather than doubled mono.
        // That width is most of why this reads as air rather than as hiss.
        const noiseL = new Tone.Noise({ type: 'pink', volume: -11 }).connect(wHPL);
        const noiseR = new Tone.Noise({ type: 'pink', volume: -11 }).connect(wHPR);
        noiseL.start();
        noiseR.start();

        const wBodyGain = new Tone.Gain(0).connect(wAmp);
        const wBody = new Tone.Filter({ type: 'lowpass', frequency: 110, rolloff: -24, Q: 0.5 })
            .connect(wBodyGain);
        new Tone.Noise({ type: 'brown', volume: -6 }).connect(wBody).start();

        const wHollowGain = new Tone.Gain(0).connect(wAmp);
        const wHollow = new Tone.Filter({ type: 'bandpass', frequency: 600, Q: 1.6 })
            .connect(wHollowGain);
        noiseL.connect(wHollow);

        const wSheenGain = new Tone.Gain(0).connect(wAmp);
        const wSheen = new Tone.Filter({ type: 'bandpass', frequency: 3200, Q: 0.6 })
            .connect(wSheenGain);
        noiseR.connect(wSheen);

        // --- bells: silent until a cohesion event strikes one ---
        const bellFilter = new Tone.Filter({ type: 'lowpass', frequency: 2500, rolloff: -12 })
            .connect(bellBus);
        const bells = new Tone.PolySynth(Tone.FMSynth, {
            harmonicity: 2.51, // inharmonic partial, so it reads as struck metal
            modulationIndex: 2.6,
            oscillator: { type: 'sine' },
            // A 280 ms attack, not a transient: the flock swells into a bell.
            envelope: { attack: 0.28, attackCurve: 'sine', decay: 6, sustain: 0, release: 4.5 },
            modulation: { type: 'sine' },
            modulationEnvelope: { attack: 0.35, decay: 2.5, sustain: 0, release: 2 },
        }).connect(bellFilter);
        bells.maxPolyphony = SOUND.maxVoices;
        bells.volume.value = -11;

        // Fade the buses in over 600 ms so switching sound on is not a click.
        windBus.gain.rampTo(SOUND.windLevel, 0.6);
        bellBus.gain.rampTo(SOUND.bellLevel, 0.6);

        return {
            masterGain, windPan, bellPan, windBus, bellBus,
            wAmp, wAirL, wAirR, wBody, wBodyGain,
            wHollow, wHollowGain, wSheen, wSheenGain,
            bellFilter, bells,
        };
    }

    // state: { order, energy, density, centroidX, panic }, all 0..1 except
    // centroidX which is -1..1. Call at ~30 Hz; more than that just floods the
    // audio thread with automation events it will smooth away anyway.
    update(state) {
        if (!this.running) return;
        const N = this.nodes;
        const t = SOUND.smoothing;
        const o = state.order;
        const d = state.density;
        const e = state.energy;
        // Energy in this sim is a near-constant, so it sets the bed's level and
        // density carries the movement — the flock thickening and thinning is
        // the only thing here with real dynamic range. Panic multiplies on top.
        const bed = SOUND.windFloor + (1 - SOUND.windFloor) * d;
        const surge = 1 + state.panic * SOUND.panicLift;

        N.windPan.pan.rampTo(state.centroidX * SOUND.windPanScale, t);

        // Brightness rides the channels that move. Octaves rather than linear
        // Hz, so the sweep is even to the ear across its whole range.
        const bright = Math.min(1, d * 0.78 + state.panic * 0.45);
        const cutoff = SOUND.windCutoffBase * Math.pow(2, bright * SOUND.windCutoffOctaves);
        N.wAirL.frequency.rampTo(cutoff, t);
        N.wAirR.frequency.rampTo(cutoff * 1.18, t); // offset top end keeps the sides apart
        N.wAmp.gain.rampTo(Math.pow(e, 0.95) * 0.42 * bed * surge, t);
        N.wBody.frequency.rampTo(80 + d * 340, t);
        N.wBodyGain.gain.rampTo(0.34 + d * 0.55, t);
        // The valley keeps order, which is near-frozen when the flock is left
        // alone and comes alive the moment you interfere with it — so this is
        // the layer that answers the cursor. Density sharpens it.
        N.wHollow.frequency.rampTo(420 + o * 1480, t);
        N.wHollow.Q.rampTo(1.2 + d * 2.4, t); // caps at 3.6 — shape, not whistle
        N.wHollowGain.gain.rampTo((0.22 + d * 0.58) * 0.42, t);
        // Sheen is the top of a gust. It used to sit at a constant 0.065; now
        // it is near-silent until something disturbs the flock.
        N.wSheen.frequency.rampTo(1500 + bright * 1400, t);
        N.wSheenGain.gain.rampTo((0.02 + state.panic * 0.5) * 0.16, t);

        N.bellFilter.frequency.rampTo(900 + Math.pow(e, 1.2) * 4300, t);
    }

    // One cohesion event, struck as a single gesture. Density sets how many
    // voices and how low, order sets how tightly they cluster in the scale,
    // energy sets how hard they are hit.
    // kind 'cohesion' — the flock pulling tight. Low, wide, several voices.
    // kind 'alarm'    — the flock recoiling from the cursor. High, tight, one
    //                   or two voices, so the two events never sound alike.
    strike(state, atX = 0, kind = 'cohesion') {
        if (!this.running) return;
        const N = this.nodes;
        const alarm = kind === 'alarm';

        // Placed before the notes start, so a strike rings from where it
        // happened rather than sliding in from the last one's position.
        N.bellPan.pan.rampTo(atX * SOUND.bellPanScale, 0.05);

        let count = alarm ? 1 + Math.round(state.panic * 1.4) : 1 + Math.round(state.density * 3);
        count = Math.min(count, SOUND.maxVoices - this.activeBells);
        if (count <= 0) return;

        const span = alarm ? 3 : Math.round(3 + (1 - state.order) * 7); // scattered spreads wider
        const room = Math.max(0, PENTATONIC.length - 1 - span);
        // Alarm rings in the top of the scale; cohesion sits low when dense.
        const centre = alarm ? room : Math.round((1 - state.density) * room);
        const velocity = alarm
            ? 0.3 + state.panic * 0.5
            : 0.2 + Math.pow(state.energy, 0.8) * 0.6;
        const now = Tone.now();

        const picked = new Set();
        let guard = 0;
        while (picked.size < count && guard++ < 40) {
            picked.add(Math.min(PENTATONIC.length - 1, centre + Math.floor(Math.random() * (span + 1))));
        }
        picked.forEach((i) => {
            // Up to 60 ms of strike spread. That is voicing, not a sequence:
            // nothing is scheduled beyond this one gesture.
            N.bells.triggerAttackRelease(PENTATONIC[i], 4.5, now + Math.random() * 0.06, velocity);
        });

        const fired = picked.size;
        this._duck(Math.min(1, velocity + fired * 0.06));
        this.activeBells += fired;
        setTimeout(() => {
            this.activeBells = Math.max(0, this.activeBells - fired);
        }, 9500);
    }

    // The wind leans back under a strike so the bell reads without either
    // getting louder. Slow on both sides — a breath held, not a pump.
    _duck(amount) {
        if (SOUND.duckDepth <= 0) return;
        const rest = this.muted ? 0 : SOUND.windLevel;
        if (rest <= 0) return;
        this.nodes.windBus.gain.rampTo(rest * (1 - SOUND.duckDepth * amount), 0.35);
        clearTimeout(this.duckTimer);
        this.duckTimer = setTimeout(() => {
            if (this.running && !this.muted) this.nodes.windBus.gain.rampTo(SOUND.windLevel, 2);
        }, 450);
    }

    setMuted(muted) {
        this.muted = muted;
        if (!this.running) return;
        this.nodes.masterGain.gain.rampTo(muted ? 0 : SOUND.master, 0.4);
    }
}
