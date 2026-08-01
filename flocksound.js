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
    // Cohesion now fires about every 3 s rather than every 10, so bell tails
    // overlap where they used to stand alone. At the old cap of 12 the pool
    // ran dry and whole strikes came out silent — 5 of 100 undisturbed, 17 of
    // 100 with a cursor in the flock, measured by replaying the detector
    // against the voice bookkeeping. An event the flock caused that makes no
    // sound is worse than a rare one.
    maxVoices: 16,
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
    // 0.16 is about -1.5 dB. Zero for a plain sum.
    //
    // This was 0.28 with a 2.9 s envelope, which read as a breath when bells
    // were 10 s apart. At the current event rate the median gap between
    // strikes is 1.8 s, so that envelope never returned to rest: the bed would
    // have sat permanently down and pumped on every chime. Shallower and
    // shorter, so it still opens a hole for the bell and still gets back.
    duckDepth: 0.16,
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
    'E2', 'G2', 'A2', 'C3', 'D3', 'E3', 'G3', 'A3',
    'C4', 'D4', 'E4', 'G4', 'A4', 'C5', 'D5', 'E5', 'G5',
];

// The two kinds of bell get their own register, and the registers do not touch.
//
// They used to share the whole scale, with cohesion's centre sliding up as the
// flock loosened. That put its top note at exactly the last index of the scale
// — the same G5 the alarm rings — so the two events overlapped by construction,
// not by accident: 14.5% of cohesion notes landed at or above the alarm's
// lowest note over a 300 s run with a cursor in the flock, and the gap between
// cohesion's p95 and the alarm's p05 was zero. Whatever else distinguished
// them, they were often literally the same pitch.
//
// Separated, cohesion's median falls from 262 Hz to 147 Hz and the highest
// chime it can possibly strike sits exactly an octave under the lowest note the
// alarm can possibly strike — worst case against worst case, not a comparison
// of percentiles. D4-A4 is left empty between the bands: a gap you can hear is
// what makes them read as two different things rather than as one instrument
// with a wide range.
const BELL_BANDS = {
    cohesion: [0, 8],   // E2..C4 — the flock's own low, wide voice
    alarm: [13, 16],    // C5..G5 — above everything else, so it cuts through
};

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
        // Headroom over maxVoices: the strike bookkeeping reserves a voice for
        // 5 s, the loud part of the tail, while Tone holds the allocation until
        // the release has fully rung out. Without the margin Tone would drop
        // notes the bookkeeping had already allowed.
        bells.maxPolyphony = SOUND.maxVoices + 8;
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

        // Two voices of spread rather than three: with events this close
        // together, a wide chord every time stops reading as a struck bell and
        // starts reading as a pad.
        let count = alarm ? 1 + Math.round(state.panic * 1.4) : 1 + Math.round(state.density * 2);
        count = Math.min(count, SOUND.maxVoices - this.activeBells);
        // A single voice always gets through. Thinning a strike is a voicing
        // decision; dropping it outright would break the rule that everything
        // the flock does is audible.
        if (count <= 0) count = 1;

        // Everything below is placed inside this kind's own band, so a chime can
        // never wander into the alarm's register however loose the flock gets.
        const [bandLo, bandHi] = alarm ? BELL_BANDS.alarm : BELL_BANDS.cohesion;
        const bandWidth = bandHi - bandLo;
        // Scattered spreads wider, but never wider than the band it lives in.
        const span = Math.min(bandWidth, alarm ? 3 : Math.round(3 + (1 - state.order) * 7));
        const room = bandWidth - span;
        // Alarm rings at the top of its band; cohesion sits lower when dense.
        const centre = bandLo + (alarm ? room : Math.round((1 - state.density) * room));
        const velocity = alarm
            ? 0.3 + state.panic * 0.5
            : 0.2 + Math.pow(state.energy, 0.8) * 0.6;
        const now = Tone.now();

        const picked = new Set();
        let guard = 0;
        while (picked.size < count && guard++ < 40) {
            picked.add(Math.min(bandHi, centre + Math.floor(Math.random() * (span + 1))));
        }
        picked.forEach((i) => {
            // The bottom of the cohesion band now sits inside the wind's body
            // layer rather than above it, and low tones need more level to read
            // as equally loud anyway. Lift the deepest notes by up to a quarter
            // — roughly +2 dB, deliberately short of full compensation, since
            // the point of the low band is weight rather than volume.
            const depth = alarm ? 0 : (bandHi - i) / bandWidth;
            const v = Math.min(1, velocity * (1 + depth * 0.25));
            // Up to 60 ms of strike spread. That is voicing, not a sequence:
            // nothing is scheduled beyond this one gesture.
            N.bells.triggerAttackRelease(PENTATONIC[i], 4.5, now + Math.random() * 0.06, v);
        });

        const fired = picked.size;
        this._duck(Math.min(1, velocity + fired * 0.06));
        this.activeBells += fired;
        // Held for the loud part of the tail, not the whole allocation. The old
        // 9.5 s covered the note out to silence, which meant a bell that had
        // faded to nothing 4 s ago still counted against the next strike.
        setTimeout(() => {
            this.activeBells = Math.max(0, this.activeBells - fired);
        }, 5000);
    }

    // The wind leans back under a strike so the bell reads without either
    // getting louder. Slow on both sides — a breath held, not a pump.
    _duck(amount) {
        if (SOUND.duckDepth <= 0) return;
        const rest = this.muted ? 0 : SOUND.windLevel;
        if (rest <= 0) return;
        this.nodes.windBus.gain.rampTo(rest * (1 - SOUND.duckDepth * amount), 0.3);
        clearTimeout(this.duckTimer);
        this.duckTimer = setTimeout(() => {
            if (this.running && !this.muted) this.nodes.windBus.gain.rampTo(SOUND.windLevel, 1.2);
        }, 350);
    }

    setMuted(muted) {
        this.muted = muted;
        if (!this.running) return;
        this.nodes.masterGain.gain.rampTo(muted ? 0 : SOUND.master, 0.4);
    }
}
