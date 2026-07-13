const flock = [];

// Tuning knobs, read live by Boid each frame. Speeds and forces are in
// px-per-frame-at-60fps units; the dt factor in draw() rescales them so the
// flock moves at the same real-world speed at any frame rate.
const settings = {
  alignWeight: 1,
  alignRadius: 50,
  cohesionWeight: 0.9,
  cohesionRadius: 100,
  separationWeight: 1.5,
  separationRadius: 30,
  maxSpeed: 4,
  minSpeed: 2,
  maxForce: 0.08,
  // The mouse. Fleeing gets its own force ceiling, well above maxForce, so
  // panic can override the flocking rules instead of being averaged into them.
  predatorRadius: 100,
  predatorWeight: 2.5,
  predatorMaxForce: 0.7,
};

const BOID_COUNT = 200;

const BACKGROUND = [4, 10, 20];

// Speed and alarm are the two things the simulation knows that the eye cannot,
// so they drive the colour: deep teal when cruising, bright aqua at full tilt.
// Alarm goes hot white-cyan rather than red — agitated dinoflagellates flash
// brighter, they don't change colour.
let CALM;
let SWIFT;
let ALARM;

// Marine snow: faint motes sinking through the water column behind the flock.
const SNOW_COUNT = 80;
const snow = [];

// Toggled with the F key; smoothed so the readout is legible, not a blur.
let showFps = false;
let fpsSmooth = 60;

function setup() {
  createCanvas(windowWidth, windowHeight);
  strokeCap(ROUND);
  // p5 throttles draw() to 60 by default. 240 lifts the throttle; the real
  // ceiling is the monitor refresh rate, since p5 runs on requestAnimationFrame.
  frameRate(240);

  CALM = color(45, 150, 170);
  SWIFT = color(120, 240, 215);
  ALARM = color(215, 250, 255);

  for (let i = 0; i < SNOW_COUNT; i++) {
    snow.push({
      x: random(width),
      y: random(height),
      r: random(0.7, 2),
      fall: random(0.1, 0.35),
      swayPhase: random(TWO_PI),
      alpha: random(30, 75),
    });
  }

  for (let i = 0; i < BOID_COUNT; i++) {
    flock.push(new Boid());
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// Null until the cursor is actually over the canvas — otherwise p5 reports
// (0, 0) on load and the flock would flee an invisible predator in the corner.
function currentPredator() {
  const inside = mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height;
  return inside ? { x: mouseX, y: mouseY } : null;
}

function drawPredator(predator) {
  const pulse = 1 + 0.03 * sin(millis() * 0.003);
  noFill();
  stroke(120, 220, 255, 40);
  strokeWeight(0);
  circle(predator.x, predator.y, settings.predatorRadius * 2 * pulse);
}

// The sway is a function of wall-clock time rather than accumulated per-mote
// state, so a mote's drift stays deterministic and frame-rate independent.
function drawSnow(dt) {
  noStroke();
  for (const mote of snow) {
    mote.y += mote.fall * dt;
    if (mote.y > height) mote.y = 0;

    const x = mote.x + 8 * sin(millis() * 0.0006 + mote.swayPhase);
    fill(170, 195, 215, mote.alpha);
    circle(((x % width) + width) % width, mote.y, mote.r * 2);
  }
}

function keyPressed() {
  if (key === 'f' || key === 'F') showFps = !showFps;
}

function drawFps() {
  fpsSmooth = lerp(fpsSmooth, frameRate(), 0.05);
  noStroke();
  fill(120, 220, 255, 180);
  textSize(12);
  text(`${fpsSmooth.toFixed(0)} fps`, 10, 20);
}

function draw() {
  // Timestep normalised to the old 60fps baseline: 1 at 60fps, 0.25 at 240fps.
  // Clamped so a backgrounded tab doesn't come back with one giant step that
  // teleports the whole flock.
  const dt = Math.min(deltaTime / (1000 / 60), 3);

  background(...BACKGROUND);

  drawSnow(dt);

  // Everything luminous is drawn additively onto the dark water, so
  // overlapping glows brighten each other instead of painting over.
  blendMode(ADD);

  const predator = currentPredator();
  if (predator) drawPredator(predator);

  for (const boid of flock) {
    boid.edges();
    boid.flock(flock, predator);
    boid.update(dt);
    boid.show();
  }

  blendMode(BLEND);

  if (showFps) drawFps();
}
