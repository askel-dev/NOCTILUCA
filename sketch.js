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
// The water blushes toward this when the flock is alarmed — same hue family
// as ALARM, just barely lifted so it reads as mood, not a strobe.
const BACKGROUND_ALARM = [11, 18, 40];
// Smoothed well below stats.out.panic's own smoothing so the background drifts
// rather than tracks — a mood, not a meter.
let bgPanicSmooth = 0;

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

// Sonification. The flock is the instrument: nothing is scheduled, and every
// sound traces to something the boids just did. Audio needs a user gesture to
// start, so it waits for the first click or keypress.
let stats = null;
let sound = null;
let soundMuted = false;
let showStats = false;
// Feeding the audio at 240fps would flood it with automation events it only
// smooths away again. Thirty is well under the 180 ms ramps it uses.
const AUDIO_HZ = 30;
let audioAccum = 0;
// Fades the "click for sound" prompt out once audio is running.
let promptFade = 1;

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

  stats = new FlockStats();
  sound = new FlockSound();
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
  sound.start();
  if (key === 'f' || key === 'F') showFps = !showFps;
  if (key === 'g' || key === 'G') showStats = !showStats;
  if (key === 'm' || key === 'M') {
    soundMuted = !soundMuted;
    sound.setMuted(soundMuted);
  }
}

// The predator follows the cursor, not clicks, so spending the click on the
// AudioContext gesture costs the sketch nothing.
function mousePressed() {
  sound.start();
}

function drawFps() {
  fpsSmooth = lerp(fpsSmooth, frameRate(), 0.05);
  noStroke();
  fill(120, 220, 255, 180);
  textSize(12);
  text(`${fpsSmooth.toFixed(0)} fps`, 10, 20);
}

// Raw values next to the auto-ranged ones the audio actually hears. Worth
// watching for a minute after any change to the flocking weights: if a raw
// column barely moves, that channel is being amplified out of near-nothing and
// the sound will be jumpier than the flock looks.
function drawStats() {
  const rows = [
    ['order', stats.raw.order, stats.out.order],
    ['energy', stats.raw.energy, stats.out.energy],
    ['density', stats.raw.density, stats.out.density],
    ['panic', stats.raw.panic, stats.out.panic],
    ['centroid', stats.raw.centroidR, stats.out.centroidX],
  ];

  noStroke();
  textSize(12);
  fill(120, 220, 255, 110);
  text('raw / mapped', 10, height - 96);

  rows.forEach(([name, raw, mapped], i) => {
    const y = height - 78 + i * 15;
    fill(120, 220, 255, 150);
    text(name, 10, y);
    text(raw.toFixed(2), 78, y);
    fill(140, 245, 220, 210);
    text(mapped.toFixed(2), 124, y);
    // A bar for the mapped value, since that is the one driving the sound.
    fill(140, 245, 220, 70);
    rect(166, y - 8, 90 * Math.abs(mapped), 8);
  });
}

function drawSoundPrompt() {
  if (sound.running) promptFade = Math.max(0, promptFade - 0.02);
  if (promptFade <= 0) return;
  noStroke();
  fill(120, 220, 255, 90 * promptFade);
  textSize(12);
  textAlign(CENTER);
  text('click for sound', width / 2, height - 24);
  textAlign(LEFT);
}

function draw() {
  // Timestep normalised to the old 60fps baseline: 1 at 60fps, 0.25 at 240fps.
  // Clamped so a backgrounded tab doesn't come back with one giant step that
  // teleports the whole flock.
  const dt = Math.min(deltaTime / (1000 / 60), 3);

  bgPanicSmooth = lerp(bgPanicSmooth, stats.out.panic, 0.01);
  background(
    lerp(BACKGROUND[0], BACKGROUND_ALARM[0], bgPanicSmooth),
    lerp(BACKGROUND[1], BACKGROUND_ALARM[1], bgPanicSmooth),
    lerp(BACKGROUND[2], BACKGROUND_ALARM[2], bgPanicSmooth)
  );

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

  // Stats every frame so the smoothing time constants stay honest; audio at a
  // fixed 30 Hz regardless of frame rate.
  const dtSeconds = Math.min(0.1, deltaTime / 1000);
  stats.sample(flock, dtSeconds, width, predator);

  // Consumed whether or not the sound is on, otherwise unmuting fires a strike
  // from a crossing that happened minutes ago.
  const cohered = stats.takeCohesionEvent();
  const alarmed = stats.takeAlarmEvent();

  if (sound.running) {
    audioAccum += dtSeconds;
    if (audioAccum >= 1 / AUDIO_HZ) {
      audioAccum = 0;
      sound.update(stats.out);
    }
    // Alarm wins if both land on the same frame: you caused that one.
    if (alarmed) sound.strike(stats.out, stats.alarmX, 'alarm');
    else if (cohered) sound.strike(stats.out, stats.eventX);
  }

  if (showFps) drawFps();
  if (showStats) drawStats();
  drawSoundPrompt();
}
