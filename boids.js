// How many past positions each boid keeps. At cruising speed one step is about
// 3px, so this is roughly a 90px streak.
const TRAIL_LENGTH = 30;

// Trail points are sampled on a wall-clock cadence (the old 60fps frame time),
// not per frame — otherwise at 240fps the same 30 points would span a quarter
// of the distance and the streaks would shrink to stubs. It also pins the
// stroke cost per second regardless of frame rate.
const TRAIL_INTERVAL_MS = 1000 / 60;

// Steps of the trail that share one stroke colour and width. More bands means a
// smoother taper and more stroke() calls; three is where it stops looking stepped.
const TRAIL_BANDS = 3;

const TAU = Math.PI * 2;

// A slot in a boid's reaction queue: the time it was sensed, the steering it
// asked for, and the alarm that came with it.
const SENSE_STRIDE = 4;

// Frame rate the reaction queues are sized for. Run faster than this and the
// oldest slot is dropped, which costs a boid a fraction of its latency rather
// than breaking anything — but no display gets here, and p5 is capped at 240.
const SENSE_MAX_HZ = 300;

// Steering forces are in px-per-frame-at-60fps squared; steerLeadTime is in
// seconds. This is the bridge between them — the number of those frames in a
// second — and is the same 60 the dt in draw() is normalised to.
const STEER_LEAD_FRAMES = 60;

// Assertions are for the desk, not the exhibit: a served page runs without them.
const DEV = typeof location === 'undefined' ||
    location.protocol === 'file:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';
let assertedOnce = false;

function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

// Folds an angle into (-pi, pi], which turns a difference of two headings into
// the shortest signed way round. Done with a modulo rather than
// atan2(sin, cos): this runs per boid per frame at up to 240fps.
function wrapAngle(a) {
    a %= TAU;
    if (a > Math.PI) a -= TAU;
    else if (a < -Math.PI) a += TAU;
    return a;
}

// Mulberry32. A boid's temperament should be the same on every reload — a flock
// that looked right yesterday still does today — so traits come off a seeded
// stream rather than Math.random. Deliberately separate from p5's random(),
// which still scatters the spawn positions unseeded.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Built on first use, not at load: settings lives in sketch.js, which is loaded
// after this file.
let traitRng = null;
let spareGaussian = null;

// Box-Muller, one cached spare per pair.
function gaussian() {
    if (spareGaussian !== null) {
        const g = spareGaussian;
        spareGaussian = null;
        return g;
    }
    let u = 0;
    while (u === 0) u = traitRng(); // log(0) is -Infinity
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = TAU * traitRng();
    spareGaussian = r * Math.sin(theta);
    return r * Math.cos(theta);
}

// base * m, m ~ N(1, traitSigma) clamped. The clamp is what stops the tail of
// the distribution from producing one boid that behaves like a different animal.
function trait(base) {
    if (!traitRng) traitRng = mulberry32(settings.traitSeed);
    const m = clamp(
        1 + gaussian() * settings.traitSigma,
        settings.traitClampLo,
        settings.traitClampHi
    );
    return base * m;
}

// p5's Perlin noise, recentred on zero. Perlin returns [0, 1] with a mean of
// 0.5, so feeding it in raw would bias every boid permanently above its cruise
// speed instead of wandering either side of it.
function noise1D(x) {
    return (noise(x) - 0.5) * 2;
}

class Boid {
    constructor() {
        this.position = createVector(random(width), random(height));

        // Velocity is state no longer: heading and speed are, and the vector is
        // rebuilt from them each update. It stays a field because the trails,
        // the glow and FlockStats all read it.
        this.heading = random(TAU);
        this.angularVelocity = 0;

        // Per-boid traits. Each is the global base times its own draw, so a boid
        // is nimble or ponderous, far-sighted or myopic, as a fixed temperament
        // rather than a per-frame accident.
        this.maxSpeed = trait(settings.maxSpeed);
        this.maxTurnRate = trait(settings.maxTurnRate);
        this.maxAngularAccel = trait(settings.maxAngularAccel);
        this.radius = trait(settings.boidRadius);
        // One draw scales the whole sensing envelope, so a far-sighted boid is
        // far-sighted in all three rules rather than only one.
        const perception = trait(1);
        this.perceptionRadius = settings.cohesionRadius * perception;
        this.alignRadius = settings.alignRadius * perception;
        this.separationRadius = settings.separationRadius * perception;

        this.cruiseSpeed = this.maxSpeed * settings.cruiseFactor;
        this.maxAccel = this.cruiseSpeed * settings.maxAccelFactor;
        this.minSpeed = this.maxSpeed * settings.minSpeedFactor;
        // Decorrelates the wander noise; without it the whole flock would
        // speed up and slow down in lockstep.
        this.noiseOffset = traitRng() * 1000;

        // Reaction latency. Everything flock() works out is filed away and only
        // acted on once it is this old, so a boid is always steering on a world
        // that has already moved on. Uniform rather than the gaussian the other
        // traits use: this is a nerve, not a temperament, and the flat spread is
        // what keeps the slow boids from clustering around one value.
        this.reactionTime = settings.reactionMin +
            traitRng() * (settings.reactionMax - settings.reactionMin);
        // The queue itself, oldest entry first. Flat Float32Array rather than
        // objects in a ring of arrays: it is written once per boid per frame,
        // and this way the whole thing is one allocation that never churns.
        const slots = Math.ceil(this.reactionTime * SENSE_MAX_HZ) + 2;
        this.sense = new Float32Array(slots * SENSE_STRIDE);
        this.senseStart = 0;
        this.senseLength = 0;
        // What avoidPredator() felt this frame, waiting its turn in the queue.
        this.sensedPanic = 0;
        this.speedState = 'normal';
        this.stateTimer = 0;
        this.age = 0;

        this.speed = clamp(random(2, 4), this.minSpeed, this.maxSpeed);
        this.velocity = createVector(
            Math.cos(this.heading) * this.speed,
            Math.sin(this.heading) * this.speed
        );
        this.acceleration = createVector();
        // Purely cosmetic: smaller, fainter boids read as further away, which
        // stops 200 identical marks from looking like a flat sheet.
        this.depth = random(0.72, 1.28);
        // Offsets each organism's glow pulse so the school shimmers instead of
        // throbbing in unison.
        this.pulsePhase = random(TWO_PI);
        this.panic = 0;
        // Neighbours inside cohesionRadius, recorded by flock() for the
        // sonification. See the note there.
        this.neighbours = 0;
        // Trails are redrawn from this history onto a cleared canvas each frame
        // rather than being left to decay in place. Decaying in place is the
        // usual trick and it does not work here: in 8-bit, fading a mark that is
        // already close to the background rounds to no change at all, so the
        // canvas silts up with scribble that never leaves.
        this.trail = [];
        this.trailTimer = 0;
    }

    edges() {
        if (this.position.x > width) this.position.x = 0;
        else if (this.position.x < 0) this.position.x = width;
        if (this.position.y > height) this.position.y = 0;
        else if (this.position.y < 0) this.position.y = height;
    }

    // dt is the frame's timestep normalised to the 60fps baseline, so speeds
    // and forces keep their tuned feel at any frame rate. Component-wise math
    // rather than p5.Vector copies: update runs per boid per frame, and at
    // 240fps the throwaway vector allocations become real GC pressure.
    update(dt) {
        // dt is in 60fps frames; the turning and speed models are written in
        // real seconds, and this is the exact conversion between them.
        const dtSec = dt / 60;
        this.age += dtSec;

        this.updateHeading(dtSec);
        this.updateSpeed(dtSec);
        if (DEV) this.assertLimits();

        // The velocity vector is derived, not integrated. Everything downstream
        // reads it exactly as before.
        this.velocity.x = Math.cos(this.heading) * this.speed;
        this.velocity.y = Math.sin(this.heading) * this.speed;

        this.position.x += this.velocity.x * dt;
        this.position.y += this.velocity.y * dt;
        this.acceleration.mult(0);

        // Alarm bleeds off rather than snapping to zero, so a boid still reads
        // as rattled for a moment after it has escaped the radius. pow keeps
        // the half-life constant when frames get shorter.
        this.panic *= Math.pow(0.93, dt);

        this.trailTimer += deltaTime;
        if (this.trailTimer >= TRAIL_INTERVAL_MS) {
            // Carry the remainder, capped at one interval: below 60fps this
            // degrades to one sample per frame, which is the old behaviour.
            this.trailTimer = Math.min(this.trailTimer - TRAIL_INTERVAL_MS, TRAIL_INTERVAL_MS);
            this.trail.push(this.position.x, this.position.y);
            if (this.trail.length > TRAIL_LENGTH * 2) this.trail.splice(0, 2);
        }
    }

    // Steering proposes a direction; the body decides how fast it can get there.
    // A boid carries angular momentum, so it leans into a turn and overshoots
    // out of it rather than snapping to whatever the rules asked for this frame.
    updateHeading(dtSec) {
        // Where the forces flock() accumulated would carry the velocity over
        // steerLeadTime — that projection is the desired direction. The lead is
        // what makes the forces mean anything as a heading: maxForce is 0.08
        // against a cruise of 2.4, so one frame of it is a two-degree nudge, and
        // aiming at that would leave the flock turning at a crawl. Projected
        // forward it recovers the turn rates the old velocity integration had,
        // with the caps below now the thing that limits them.
        //
        // The result is read as a direction only — its magnitude is deliberately
        // discarded, because speed is state now and steering must not set it.
        const lead = STEER_LEAD_FRAMES * settings.steerLeadTime;
        const desiredX = this.velocity.x + this.acceleration.x * lead;
        const desiredY = this.velocity.y + this.acceleration.y * lead;
        // A zero desired vector has no heading to speak of; hold the current one.
        const desiredHeading = (desiredX || desiredY)
            ? Math.atan2(desiredY, desiredX)
            : this.heading;

        const err = wrapAngle(desiredHeading - this.heading);
        // turnResponseTime is the time the boid would take to null the error out
        // if nothing capped it: bigger errors want proportionally faster turns,
        // up to the rate its body can hold.
        const desiredAngularVel = clamp(
            err / settings.turnResponseTime,
            -this.maxTurnRate,
            this.maxTurnRate
        );
        const dw = this.maxAngularAccel * dtSec;
        this.angularVelocity += clamp(desiredAngularVel - this.angularVelocity, -dw, dw);
        this.heading = wrapAngle(this.heading + this.angularVelocity * dtSec);
    }

    // Speed is a state with its own life: a slow wander around cruise, broken
    // now and then by a dart and the winded coast that follows it.
    updateSpeed(dtSec) {
        if (this.speedState === 'normal') {
            // Compounded rather than multiplied, so the chance of a burst over a
            // given second is the same at 60fps and at 240.
            if (traitRng() < 1 - Math.pow(1 - settings.burstChance, dtSec)) {
                this.speedState = 'burst';
                this.stateTimer = settings.burstMin +
                    traitRng() * (settings.burstMax - settings.burstMin);
            }
        } else {
            this.stateTimer -= dtSec;
            if (this.stateTimer <= 0) {
                if (this.speedState === 'burst') {
                    this.speedState = 'coast';
                    this.stateTimer = settings.coastMin +
                        traitRng() * (settings.coastMax - settings.coastMin);
                } else {
                    this.speedState = 'normal';
                }
            }
        }

        let targetSpeed;
        if (this.speedState === 'burst') {
            targetSpeed = this.maxSpeed;
        } else if (this.speedState === 'coast') {
            targetSpeed = this.cruiseSpeed * settings.coastFactor;
        } else {
            targetSpeed = this.cruiseSpeed * (1 + settings.speedNoiseAmp *
                noise1D(this.age * settings.speedNoiseRate + this.noiseOffset));
        }

        const da = this.maxAccel * dtSec;
        this.speed = clamp(
            this.speed + clamp(targetSpeed - this.speed, -da, da),
            this.minSpeed,
            this.maxSpeed
        );
    }

    // The two caps the motion model is built on. Warns once rather than per boid
    // per frame — at 200 boids and 240fps a repeating warning is a hang.
    assertLimits() {
        if (assertedOnce) return;
        const eps = 1e-6;
        if (this.speed > this.maxSpeed + eps || this.speed < this.minSpeed - eps) {
            assertedOnce = true;
            console.warn(`Boid speed ${this.speed} outside [${this.minSpeed}, ${this.maxSpeed}]`);
        } else if (Math.abs(this.angularVelocity) > this.maxTurnRate + eps) {
            assertedOnce = true;
            console.warn(`Boid angularVelocity ${this.angularVelocity} exceeds ${this.maxTurnRate}`);
        }
    }

    // Files this frame's sensing at the back of the queue, dropping the oldest
    // entry if the queue is full — see SENSE_MAX_HZ.
    pushSense(t, ax, ay, panic) {
        const cap = this.sense.length / SENSE_STRIDE;
        if (this.senseLength === cap) {
            this.senseStart = (this.senseStart + 1) % cap;
            this.senseLength--;
        }
        const i = ((this.senseStart + this.senseLength) % cap) * SENSE_STRIDE;
        this.sense[i] = t;
        this.sense[i + 1] = ax;
        this.sense[i + 2] = ay;
        this.sense[i + 3] = panic;
        this.senseLength++;
        return i;
    }

    // Index of the newest entry that has finished waiting out the latency.
    // Everything older is dropped on the way: t only ever moves forward, so
    // nothing will ask for those again. During the first reactionTime of a
    // boid's life the queue has nothing due yet and it acts on the oldest it
    // has, which is the least stale reading available.
    dueSense(t) {
        const cap = this.sense.length / SENSE_STRIDE;
        const due = t - this.reactionTime;
        while (this.senseLength > 1 &&
            this.sense[((this.senseStart + 1) % cap) * SENSE_STRIDE] <= due) {
            this.senseStart = (this.senseStart + 1) % cap;
            this.senseLength--;
        }
        return this.senseStart * SENSE_STRIDE;
    }

    // Steering = desired - velocity, clamped, then weighted. Fleeing passes a
    // higher forceLimit so panic can override the gentle flocking steer.
    steerTowards(desired, weight, forceLimit = settings.maxForce) {
        desired.setMag(this.maxSpeed);
        desired.sub(this.velocity);
        desired.limit(forceLimit);
        desired.mult(weight);
        return desired;
    }

    // Flee the predator (the mouse). Returns null when it is out of range.
    // Panic decay lives in update(), where it can be scaled by dt.
    avoidPredator(predator) {
        if (!predator) return null;

        const dx = this.position.x - predator.x;
        const dy = this.position.y - predator.y;
        const dSq = dx * dx + dy * dy;
        const radius = settings.predatorRadius;

        if (dSq > radius * radius || dSq === 0) return null;

        // Panic ramps from 0 at the edge of the radius to 1 at contact, so
        // boids peel away smoothly instead of snapping when it comes near.
        // Recorded rather than applied: it rides the reaction queue with the
        // steering it belongs to, so the flash and the flinch stay together.
        const panic = 1 - Math.sqrt(dSq) / radius;
        this.sensedPanic = panic;

        return this.steerTowards(
            createVector(dx, dy), // directly away from the predator
            settings.predatorWeight * panic,
            settings.predatorMaxForce
        );
    }

    flock(boids, predator) {
        const alignRadiusSq = this.alignRadius ** 2;
        const cohesionRadiusSq = this.perceptionRadius ** 2;
        const separationRadiusSq = this.separationRadius ** 2;

        const alignment = createVector();
        const cohesion = createVector();
        const separation = createVector();
        let alignTotal = 0;
        let cohesionTotal = 0;
        let separationTotal = 0;

        this.sensedPanic = 0;

        // The blind spot: a cone of settings.blindAngle directly astern that
        // none of the three rules can see into. Tested on the dot product of
        // the heading with the direction to the neighbour, left squared so the
        // loop still never takes a square root — with c the cosine of the
        // cone's half-angle measured off the tail, a neighbour is hidden when
        // it is behind (dot < 0) and dot^2 > c^2 * dSq. At blindAngle 0 the
        // cosine is 1 and the test can never pass, which switches it off.
        const forwardX = Math.cos(this.heading);
        const forwardY = Math.sin(this.heading);
        const blindCosSq = Math.cos(settings.blindAngle * Math.PI / 360) ** 2;

        // One pass over the neighbours feeding all three rules. Distances stay
        // squared so we never pay for a square root.
        for (const other of boids) {
            if (other === this) continue;

            const dx = other.position.x - this.position.x;
            const dy = other.position.y - this.position.y;
            const dSq = dx * dx + dy * dy;

            const forward = dx * forwardX + dy * forwardY;
            if (forward < 0 && forward * forward > blindCosSq * dSq) continue;

            if (dSq < alignRadiusSq) {
                alignment.add(other.velocity);
                alignTotal++;
            }

            if (dSq < cohesionRadiusSq) {
                cohesion.add(other.position);
                cohesionTotal++;
            }

            // dSq > 0 guards two boids landing on the exact same point, which
            // would divide by zero and poison the position with NaN.
            if (dSq < separationRadiusSq && dSq > 0) {
                // Away from the neighbour, inverse-square weighted so the
                // closest ones push hardest. Added component-wise: this is the
                // innermost loop, and a createVector per neighbour per frame
                // is pure GC churn at high frame rates.
                separation.x -= dx / dSq;
                separation.y -= dy / dSq;
                separationTotal++;
            }
        }

        // Handed to FlockStats as the density signal. Kept here because the
        // count is a free by-product of a scan that has already run — finding
        // it again would mean a second O(n^2) pass purely for the audio. It is
        // what this boid can see, blind spot and all, which is why the density
        // seeds in flockstats.js had to be re-measured when the cone went in.
        this.neighbours = cohesionTotal;

        if (alignTotal > 0) {
            alignment.div(alignTotal);
            this.acceleration.add(this.steerTowards(alignment, settings.alignWeight));
        }

        if (cohesionTotal > 0) {
            cohesion.div(cohesionTotal);
            cohesion.sub(this.position); // desired: toward the centre of mass
            this.acceleration.add(this.steerTowards(cohesion, settings.cohesionWeight));
        }

        if (separationTotal > 0) {
            separation.div(separationTotal);
            this.acceleration.add(this.steerTowards(separation, settings.separationWeight));
        }

        const flee = this.avoidPredator(predator);
        if (flee) this.acceleration.add(flee);

        // Everything above is what the boid senses now. What it acts on is what
        // it sensed reactionTime ago, so the accumulated steering goes into the
        // queue and comes back out as whatever is due. The vector is overwritten
        // rather than added to: this is the same steer, just late.
        this.pushSense(this.age, this.acceleration.x, this.acceleration.y, this.sensedPanic);
        const due = this.dueSense(this.age);
        this.acceleration.x = this.sense[due + 1];
        this.acceleration.y = this.sense[due + 2];
        this.panic = Math.max(this.panic, this.sense[due + 3]);
    }

    show() {
        const speed = this.velocity.mag();
        const haste = constrain(
            (speed - settings.minSpeed) / (settings.maxSpeed - settings.minSpeed),
            0,
            1
        );

        const ink = lerpColor(lerpColor(CALM, SWIFT, haste), ALARM, this.panic);
        const solid = map(this.depth, 0.72, 1.28, 120, 235);
        // Wall-clock time, not frameCount: the shimmer should pulse at the
        // same tempo whether the sketch runs at 60fps or 240fps.
        const pulse = 0.8 + 0.2 * sin(millis() * 0.0048 + this.pulsePhase);

        this.showTrail(ink, solid);
        this.showBody(ink, solid, pulse);
    }

    // The trail tapers to nothing at the tail, in both width and opacity — that
    // taper is the whole difference between an ink stroke and a smear.
    //
    // The taper is banded rather than per-segment because stroke() is the
    // expensive call, not the geometry: one stroke per segment is 30 strokes a
    // boid and drops the sketch to ~23fps, where three stroked polylines hold 60.
    showTrail(ink, solid) {
        const steps = this.trail.length / 2;
        if (steps < 2) return;

        noFill();

        for (let band = 0; band < TRAIL_BANDS; band++) {
            const from = Math.floor((band * (steps - 1)) / TRAIL_BANDS);
            const to = Math.floor(((band + 1) * (steps - 1)) / TRAIL_BANDS);
            const age = (band + 1) / TRAIL_BANDS;

            // 0.25 rather than the 0.42 the old opaque style used: under ADD
            // blending overlapping trails sum, and 0.42 blows out to white
            // wherever the flock bunches.
            ink.setAlpha(solid * 0.25 * age);
            stroke(ink);
            strokeWeight(1.4 * this.depth * age);

            beginShape();
            let prevX = null;
            let prevY = null;
            for (let i = from; i <= to; i++) {
                const x = this.trail[i * 2];
                const y = this.trail[i * 2 + 1];
                // edges() teleports a boid to the far side of the canvas. Break
                // the stroke there, or it draws a line right across the screen.
                if (prevX !== null && (Math.abs(x - prevX) > 50 || Math.abs(y - prevY) > 50)) {
                    endShape();
                    beginShape();
                }
                vertex(x, y);
                prevX = x;
                prevY = y;
            }
            endShape();
        }
    }

    // Three concentric layers under ADD blending: two soft halos and a hot
    // near-white core. Layered translucent shapes are what keep 200 glows at
    // 60fps — shadowBlur would do it in one call and cost the frame rate.
    //
    // The core is an ellipse elongated along the heading rather than a dot:
    // the orientation is what makes the flock's turning legible.
    showBody(ink, solid, pulse) {
        const nose = this.radius * this.depth;

        push();
        translate(this.position.x, this.position.y);
        rotate(this.velocity.heading());
        noStroke();

        // Outer halo, swollen by panic — the dinoflagellate flash.
        ink.setAlpha(solid * 0.06 * pulse * (1 + this.panic));
        fill(ink);
        circle(0, 0, nose * 7 * (1 + this.panic * 0.5));

        // Inner halo.
        ink.setAlpha(solid * 0.22 * pulse);
        fill(ink);
        circle(0, 0, nose * 3);

        // Core.
        const core = lerpColor(ink, color(255, 255, 255), 0.45);
        core.setAlpha(solid);
        fill(core);
        ellipse(0, 0, nose, nose * 0.5);

        pop();
    }
}
