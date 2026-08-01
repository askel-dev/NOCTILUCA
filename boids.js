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

class Boid {
    constructor() {
        this.position = createVector(random(width), random(height));
        this.velocity = p5.Vector.random2D();
        this.velocity.setMag(random(2, 4));
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
        this.velocity.x += this.acceleration.x * dt;
        this.velocity.y += this.acceleration.y * dt;
        this.velocity.limit(settings.maxSpeed);
        // A near-stationary boid has an ill-defined heading, so steering forces
        // spin it wildly. Keeping it moving is what stops the jitter.
        if (this.velocity.mag() < settings.minSpeed) {
            this.velocity.setMag(settings.minSpeed);
        }
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

    // Steering = desired - velocity, clamped, then weighted. Fleeing passes a
    // higher forceLimit so panic can override the gentle flocking steer.
    steerTowards(desired, weight, forceLimit = settings.maxForce) {
        desired.setMag(settings.maxSpeed);
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
        const panic = 1 - Math.sqrt(dSq) / radius;
        this.panic = Math.max(this.panic, panic);

        return this.steerTowards(
            createVector(dx, dy), // directly away from the predator
            settings.predatorWeight * panic,
            settings.predatorMaxForce
        );
    }

    flock(boids, predator) {
        const alignRadiusSq = settings.alignRadius ** 2;
        const cohesionRadiusSq = settings.cohesionRadius ** 2;
        const separationRadiusSq = settings.separationRadius ** 2;

        const alignment = createVector();
        const cohesion = createVector();
        const separation = createVector();
        let alignTotal = 0;
        let cohesionTotal = 0;
        let separationTotal = 0;

        // One pass over the neighbours feeding all three rules. Distances stay
        // squared so we never pay for a square root.
        for (const other of boids) {
            if (other === this) continue;

            const dx = other.position.x - this.position.x;
            const dy = other.position.y - this.position.y;
            const dSq = dx * dx + dy * dy;

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
        // it again would mean a second O(n^2) pass purely for the audio.
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
        const nose = 5.5 * this.depth;

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
