// Aggregate flock statistics for the sonification.
//
// One O(n) pass per frame, riding on work Boid.flock() has already done, so it
// costs a rounding error next to the O(n^2) neighbour scan.
//
// The constants here are not guesses. They come from running this exact flock
// headlessly for 150 s and reading the distributions off it; the figures quoted
// below are from that run. Re-measure after changing any flocking weight.
//
// Three properties of this simulation break the obvious versions of these
// numbers, and all three are handled here rather than in the audio:
//
//   * Speed is clamped to [minSpeed, maxSpeed] and every steering force in
//     steerTowards() starts by setting the desired magnitude to maxSpeed — so
//     all three rules continuously push each boid's speed toward the ceiling.
//     Averaged over 200 boids, raw mean speed sits at 0.766 and moves 0.08
//     units/s. Auto-ranging it turned that wiggle into full-range swings, so
//     energy is now mapped through a fixed divisor instead.
//
//   * Order is pinned high — median 0.960, and it never fell below 0.869 in
//     150 s. Alignment carries almost no information in this flock, so it only
//     shapes timbre and the cohesion detector reads density instead.
//
//   * edges() wraps the canvas. A plain mean of position.x is meaningless on a
//     torus: it pins near width/2 for a spread flock and jumps discontinuously
//     when a cluster straddles the seam. The centroid is a circular mean, and
//     its resultant length gates how far it is allowed to pan — when the flock
//     is spread the angle is not just useless but unstable, so it collapses to
//     centre instead of jittering.

// Cohesion is read off density, not order. Measured over 150 s of this sim,
// order sits at 0.96 with a 5-95 spread of 0.909-0.986: these boids are almost
// always aligned, so alignment carries almost no information. Density swings
// 20.8-45.2 over the same run, and a flock pulling tight is what "cohesion"
// means anyway.
//
// Detected as a rise above a falling floor, the same shape as the alarm below,
// and for the same reason. This used to be a level crossing with hysteresis
// (on at 0.56, re-armed under 0.40), which fired once per 9-11 s and made the
// bells too rare to read as the flock's voice. The thresholds were not what
// was limiting it: replaying the recorded density channel through every
// sensible on/off pair, from 0.56/0.40 down to 0.38/0.34, moved the rate only
// between one per 9.4 s and one per 6.5 s. A level crossing cannot fire again
// until density has completed a full excursion back below the release point,
// so the rate was pinned to the slowest thing in the signal no matter where
// the thresholds sat.
//
// Against a rising floor, every fresh tightening is its own event, including
// the small ones partway up a long climb — one per 3.0 s undisturbed, 2.8 s
// with a cursor in the flock, measured the same way. A flock that is merely
// dense and staying that way is silent, since nothing is rising.
const COHESION_RISE = 0.12;     // how far density must climb above its floor
const COHESION_MIN = 0.28;      // no chimes off a genuinely loose flock
const COHESION_FLOOR_TAU = 2;   // seconds for the floor to catch up
const COHESION_REFRACTORY = 1;  // seconds

// Raw mean haste, straight through, with no auto-ranging. Measured spread is
// 0.700-0.803 and it travels 0.08 units/s; auto-ranged it travelled 0.27 and
// reached 0.005, which is why the wind sounded random and kept dropping out.
// A fixed divisor keeps it a near-constant bed — and still falls to silence if
// the flock genuinely stalls, since raw haste is anchored at zero.
const ENERGY_CEILING = 0.85;

// Mean panic is small even when the cursor is ploughing through the flock:
// only the boids inside predatorRadius are alarmed at all, so it peaked at
// 0.112 over a 150 s sweep and sat at 0.036 for p95. Fed in raw it moved the
// sound by about 6%. This divisor puts an ordinary incursion near 0.6.
const PANIC_CEILING = 0.06;

// A cursor pushing into the flock is an event, not a level. Detected as a rise
// above a floor that follows panic down fast and up slowly, rather than as a
// threshold crossing: a plain crossing fires once and then latches out for as
// long as you keep the cursor in the flock, so stirring would give one chime
// and then silence. Against a rising floor, every fresh group of boids you
// startle is its own event — and holding still, which startles nobody new, is
// silent without anything needing to be scheduled.
const ALARM_RISE = 0.17;      // how much panic must jump above its floor
const ALARM_MIN = 0.12;       // ignore ripples down near zero
const ALARM_FLOOR_TAU = 1.5;  // seconds for the floor to catch up
const ALARM_REFRACTORY = 0.45; // seconds

// Below this resultant length the circular mean is noise, so the pan is muted.
// A uniformly scattered flock of 200 sits near 1/sqrt(200) = 0.07.
const CENTROID_FLOOR = 0.12;
const CENTROID_FULL = 0.47;

// Auto-gain for one channel: tracks the band the sim actually uses and maps it
// onto 0..1.
//
// The bounds are running quantile estimates, not a running min and max. Each
// sample nudges an estimate by at most one step, so a single brief clump cannot
// rescale the channel — with min/max it could, and did: one density spike set
// the ceiling for the next two minutes and the cohesion strike rate swung
// between 2 and 10 per 150 s from run to run purely on that.
//
// The step has to be small enough that this stays a calibration rather than
// becoming a compressor. Chasing the signal closely acts as a high-pass filter:
// the output loses its DC and just wanders around the middle, which is heard as
// randomness. minSpan then caps the gain so a near-constant channel is never
// inflated into noise.
const Q_LO = 0.08;
const Q_HI = 0.92;

class AutoRange {
    // seedLo/seedHi are the measured quantiles for this channel. They only set
    // the starting point — the tracker still adapts, and will follow the sim if
    // you retune it. Without them the estimate starts far too narrow and spends
    // most of a two-minute run converging, which pins the channel at its
    // ceiling for the whole time you are listening.
    constructor(minSpan, seedLo, seedHi, tau = 15) {
        this.minSpan = minSpan;
        this.tau = tau;
        this.lo = seedLo;
        this.hi = seedHi;
    }

    normalise(v, dt) {
        // Stochastic quantile approximation: drift up by q on samples above the
        // estimate, down by 1-q on samples below, and it settles on the qth
        // quantile. Step scales with the current span so it adapts in
        // proportion to the range rather than in absolute units.
        const step = Math.max(this.hi - this.lo, this.minSpan) * (dt / this.tau);
        this.lo += step * (v > this.lo ? Q_LO : Q_LO - 1);
        this.hi += step * (v > this.hi ? Q_HI : Q_HI - 1);
        if (this.hi < this.lo) {
            const mid = (this.hi + this.lo) / 2;
            this.lo = mid - this.minSpan / 2;
            this.hi = mid + this.minSpan / 2;
        }

        // Widen around the midpoint rather than from the low end. Anchoring at
        // lo would park a near-constant channel near 0 — which for energy, the
        // flattest signal this sim produces, means a silent wind. Centred, a
        // still flock sits at half and breathes from there.
        const mid = (this.lo + this.hi) / 2;
        const half = Math.max((this.hi - this.lo) / 2, this.minSpan / 2);
        return Math.min(1, Math.max(0, (v - mid) / (2 * half) + 0.5));
    }
}

// One-pole smoother with a time constant in seconds, so it behaves the same at
// 60fps and 240fps.
class OnePole {
    constructor(tau, initial = 0) {
        this.tau = tau;
        this.value = initial;
    }

    push(v, dt) {
        this.value += (v - this.value) * (1 - Math.exp(-dt / this.tau));
        return this.value;
    }
}

class FlockStats {
    constructor() {
        this.time = 0;

        // Seeds are the p05/p95 measured by tools/flockprobe.js on this sim.
        this.rangeOrder = new AutoRange(0.1, 0.78, 0.99);
        this.rangeDensity = new AutoRange(6, 20.7, 45.2);

        // Light smoothing only — the audio engine ramps over 180 ms of its own,
        // and smoothing twice just makes the flock feel sluggish.
        this.smoothOrder = new OnePole(0.1);
        this.smoothEnergy = new OnePole(0.1);
        this.smoothDensity = new OnePole(0.12);
        // Panic decays at 0.93^dt in Boid.update(), a half-life near 0.16 s.
        // Smooth it hard and the surge — the most alive signal in the sim —
        // is gone before it reaches the speakers.
        this.smoothPanic = new OnePole(0.06);
        // The centroid is smoothed as a vector, not as an angle: averaging
        // angles across the +/-pi seam would swing the pan the wrong way.
        // Slow, because this flock crosses the whole canvas repeatedly and a
        // quick pan turns the soundscape into something that sloshes.
        this.centroidCos = new OnePole(0.6, 1);
        this.centroidSin = new OnePole(0.6, 0);

        this.cohesionFloor = 0;
        this.lastEvent = -Infinity;
        this.pendingEvent = false;
        this.eventX = 0;

        this.alarmFloor = 0;
        this.lastAlarm = -Infinity;
        this.pendingAlarm = false;
        this.alarmX = 0;

        // Normalised, ready to hand to the audio engine.
        this.out = { order: 0, energy: 0, density: 0, centroidX: 0, panic: 0 };
        // Same values before normalisation, for the on-screen readout.
        this.raw = { order: 0, energy: 0, density: 0, centroidR: 0, panic: 0 };
    }

    sample(flock, dt, width, predator = null) {
        const n = flock.length;
        if (!n || dt <= 0) return;
        this.time += dt;

        const speedSpan = settings.maxSpeed - settings.minSpeed;
        const turn = (Math.PI * 2) / width;

        let vx = 0;
        let vy = 0;
        let haste = 0;
        let panic = 0;
        let neighbours = 0;
        let cx = 0;
        let cy = 0;

        for (const boid of flock) {
            const v = boid.velocity;
            // Plain sqrt rather than Math.hypot: this runs 200 times a frame at
            // up to 240fps, and hypot's overflow guarding is not free.
            const speed = Math.sqrt(v.x * v.x + v.y * v.y) || 1;
            vx += v.x / speed;
            vy += v.y / speed;

            haste += (speed - settings.minSpeed) / speedSpan;
            panic += boid.panic;
            neighbours += boid.neighbours;

            // The -pi puts screen centre at angle 0, so a centred flock pans
            // centre and the unavoidable wrap seam sits at the screen edge
            // where the flock really does jump. Without it the seam lands
            // mid-screen and the whole pan is rotated a quarter turn.
            const a = boid.position.x * turn - Math.PI;
            cx += Math.cos(a);
            cy += Math.sin(a);
        }

        this.raw.order = Math.sqrt(vx * vx + vy * vy) / n;
        this.raw.energy = haste / n;
        this.raw.density = neighbours / n;
        this.raw.panic = panic / n;

        const sc = this.centroidCos.push(cx / n, dt);
        const ss = this.centroidSin.push(cy / n, dt);
        const resultant = Math.sqrt(sc * sc + ss * ss);
        this.raw.centroidR = resultant;

        const confidence = Math.min(
            1,
            Math.max(0, (resultant - CENTROID_FLOOR) / (CENTROID_FULL - CENTROID_FLOOR))
        );
        this.out.centroidX = (Math.atan2(ss, sc) / Math.PI) * confidence;

        this.out.order = this.smoothOrder.push(this.rangeOrder.normalise(this.raw.order, dt), dt);
        this.out.energy = this.smoothEnergy.push(
            Math.min(1, this.raw.energy / ENERGY_CEILING),
            dt
        );
        const density = this.smoothDensity.push(
            this.rangeDensity.normalise(this.raw.density, dt),
            dt
        );
        this.out.density = density;
        const alarm = this.smoothPanic.push(Math.min(1, this.raw.panic / PANIC_CEILING), dt);
        this.out.panic = alarm;

        if (alarm < this.alarmFloor) this.alarmFloor = alarm;
        else this.alarmFloor += (alarm - this.alarmFloor) * (1 - Math.exp(-dt / ALARM_FLOOR_TAU));

        if (alarm > ALARM_MIN &&
            alarm - this.alarmFloor > ALARM_RISE &&
            this.time - this.lastAlarm > ALARM_REFRACTORY) {
            this.lastAlarm = this.time;
            this.pendingAlarm = true;
            this.alarmFloor = alarm; // this rise is spent
            // The bell rings where the cursor is, not where the flock averages.
            if (predator) this.alarmX = (predator.x / width) * 2 - 1;
        }

        if (density < this.cohesionFloor) this.cohesionFloor = density;
        else {
            this.cohesionFloor +=
                (density - this.cohesionFloor) * (1 - Math.exp(-dt / COHESION_FLOOR_TAU));
        }

        if (density > COHESION_MIN &&
            density - this.cohesionFloor > COHESION_RISE &&
            this.time - this.lastEvent > COHESION_REFRACTORY) {
            this.lastEvent = this.time;
            this.pendingEvent = true;
            this.cohesionFloor = density; // this tightening is spent
            // Where the flock is tightest, so the bell rings from the knot that
            // caused it rather than from the whole flock's average position.
            this.eventX = this._tightestX(flock, width);
        }
    }

    // Pan position of the most connected boid, -1..1. Only runs on an event,
    // so the extra O(n) scan costs nothing between strikes.
    _tightestX(flock, width) {
        let best = flock[0];
        for (const boid of flock) if (boid.neighbours > best.neighbours) best = boid;
        return (best.position.x / width) * 2 - 1;
    }

    // Consume the pending cohesion event, if any. Always call this, even with
    // the sound off, or the first strike after unmuting fires from a crossing
    // that happened minutes ago.
    takeCohesionEvent() {
        const event = this.pendingEvent;
        this.pendingEvent = false;
        return event;
    }

    // The flock recoiling from the cursor. Same contract as above.
    takeAlarmEvent() {
        const event = this.pendingAlarm;
        this.pendingAlarm = false;
        return event;
    }
}
