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

  // --- Per-boid traits ---------------------------------------------------
  // Each boid samples maxSpeed, maxTurnRate, maxAngularAccel, boidRadius and
  // its sensing radii as base * m, where m is gaussian(1, traitSigma) clamped
  // to [traitClampLo, traitClampHi]. The values above stay the bases. Seeded,
  // so the same flock comes back on every reload.
  traitSeed: 1337,
  traitSigma: 0.15,
  traitClampLo: 0.7,
  traitClampHi: 1.35,
  // Base visual size, previously hard-coded in showBody().
  boidRadius: 5.5,

  // --- Sensing -----------------------------------------------------------
  // A boid steers on what it sensed reactionTime ago rather than on this
  // frame's world, drawn per boid in this range. The point of the spread is
  // that the flock cannot turn as one machine: a dodge crosses it as a wave
  // with a ragged front instead of every boid flinching on the same frame.
  reactionMin: 0.05,      // seconds
  reactionMax: 0.15,
  // Total width of the cone directly astern a boid senses nothing in, in
  // degrees; 0 turns the blind spot off. It applies to the three flocking
  // rules only. The predator is exempt: a fish reads a rush from behind off
  // its lateral line rather than its eyes, and it is the one thing in the sim
  // the viewer is holding.
  blindAngle: 90,

  // --- Turning -----------------------------------------------------------
  // Real seconds and radians, not frame units: turning is a physical model and
  // reads better in the units it was reasoned about in.
  //
  // A boid steers by angular acceleration, so it cannot snap onto a new
  // heading. turnResponseTime is how long it would take to null out a heading
  // error if nothing capped it; the two caps are what it can actually hold.
  // At these values a full 180 degree reversal takes about 0.9 s — long enough
  // to watch the animal commit to it, short enough to still read as a flinch.
  turnResponseTime: 0.25,
  maxTurnRate: 4.0,       // rad/s
  maxAngularAccel: 16,    // rad/s^2
  // How far ahead a steering force is projected to read a direction off it.
  // See the note in updateHeading(). At 0.25 s a full-strength flocking steer
  // asks for about 1.9 rad/s and a predator flee asks for more than the cap,
  // which is the split that was there before: panic turns hard, flocking drifts.
  steerLeadTime: 0.25,

  // --- Speed -------------------------------------------------------------
  // Speed is state, never set by steering. It wanders around a cruise well
  // below maxSpeed, which leaves headroom for the bursts to actually read as
  // bursts.
  cruiseFactor: 0.6,      // cruiseSpeed = maxSpeed * this
  minSpeedFactor: 0.2,    // hard floor = maxSpeed * this
  maxAccelFactor: 2,      // maxAccel = cruiseSpeed * this, per second
  speedNoiseAmp: 0.25,    // wander, as a fraction of cruiseSpeed
  speedNoiseRate: 0.15,   // noise input is age * this — a slow drift, not a jitter
  burstChance: 0.02,      // per boid per second
  burstMin: 0.3,
  burstMax: 0.8,
  coastMin: 1.5,
  coastMax: 3,
  coastFactor: 0.55,      // target while coasting = cruiseSpeed * this
};

const BOID_COUNT = 200;

const BACKGROUND = [4, 10, 20];
// The water blushes toward this when the flock is alarmed — same hue family
// as ALARM, just barely lifted so it reads as mood, not a strobe.
const BACKGROUND_ALARM = [11, 18, 40];
// Smoothed well below stats.out.panic's own smoothing so the background drifts
// rather than tracks — a mood, not a meter.
let bgPanicSmooth = 0;
// Brightness of the water at the surface and at depth, as multipliers on the
// colour above. Light falling off with depth is the reason you'd want this
// anyway, but it is load-bearing for a second reason — see paintWater().
const WATER_TOP = 1.35;
const WATER_BOTTOM = 0.65;

// Speed and alarm are the two things the simulation knows that the eye cannot,
// so they drive the colour: deep teal when cruising, bright aqua at full tilt.
// Alarm goes hot white-cyan rather than red — agitated dinoflagellates flash
// brighter, they don't change colour.
let CALM;
let SWIFT;
let ALARM;

// --- Palettes --------------------------------------------------------------
// A palette is only those three stops, so switching one repaints the flock and
// leaves the water, the rays and the marine snow alone — the flock stays the
// lit thing in a dark ocean whatever colour it is.
//
// Every palette keeps the same shape as the default: the calm stop is dark and
// saturated, the swift stop is brighter and shifted a little around the wheel
// so acceleration reads as a hue change and not just a gain, and the alarm stop
// is nearly white with the hue only tinting it. Break that shape and speed
// stops being legible.
const PALETTES = [
  { name: 'Noctiluca', calm: [45, 150, 170], swift: [120, 240, 215], alarm: [215, 250, 255] },
  { name: 'Ember',     calm: [150, 70, 30],  swift: [245, 175, 80],  alarm: [255, 240, 215] },
  { name: 'Abyss',     calm: [70, 60, 175],  swift: [190, 110, 240], alarm: [240, 225, 255] },
  { name: 'Verdant',   calm: [50, 140, 80],  swift: [175, 240, 110], alarm: [240, 255, 220] },
  { name: 'Ghost',     calm: [95, 115, 145], swift: [185, 210, 235], alarm: [250, 252, 255] },
  { name: 'Coral',     calm: [165, 60, 90],  swift: [255, 140, 140], alarm: [255, 230, 235] },
];

// Where the last choice is kept, so a palette survives a reload the way the
// seeded flock does.
const PALETTE_STORE = 'noctiluca.palette';

function applyPalette(rgb) {
  CALM = color(rgb.calm[0], rgb.calm[1], rgb.calm[2]);
  SWIFT = color(rgb.swift[0], rgb.swift[1], rgb.swift[2]);
  ALARM = color(rgb.alarm[0], rgb.alarm[1], rgb.alarm[2]);
}

// A custom colour arrives as one hex — the calm stop — and the other two are
// derived from it in HSL so the ramp keeps the default's proportions: the same
// -24 degree hue swing into swift, the same climb in saturation and lightness.
// Fed the default teal, this reproduces SWIFT and ALARM to within a level or
// two, which is the check that the numbers below are the right ones.
function rampFromHex(hex) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  // A grey has no hue to swing — its h is whatever fell out of the conversion,
  // and floor a grey's saturation and you get a flock tinted red by an accident
  // of the maths. Below a nominal saturation, keep it a true silver instead.
  const sat = s < 0.05 ? 0 : Math.max(s, 0.12);
  return {
    calm: hslToRgb((h + 360) % 360, sat, Math.min(Math.max(l, 0.22), 0.55)),
    swift: hslToRgb((h - 24 + 360) % 360, Math.min(sat * 1.4, 0.82), 0.71),
    alarm: hslToRgb(h, Math.min(sat * 1.7, 1), 0.92),
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [((h * 60) + 360) % 360, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const t = h / 60;
  let rgb;
  if (t < 1) rgb = [c, x, 0];
  else if (t < 2) rgb = [x, c, 0];
  else if (t < 3) rgb = [0, c, x];
  else if (t < 4) rgb = [0, x, c];
  else if (t < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((v) => Math.round((v + m) * 255));
}

// Called by the menu in index.html. A choice is either a palette name or a hex
// string; both round-trip through localStorage as themselves.
function setPalette(choice) {
  const preset = PALETTES.find((p) => p.name === choice);
  // A stored value can outlive the palette it names — a renamed preset would
  // otherwise fall through to the hex branch and parse as NaN.
  if (!preset && !/^#[0-9a-f]{6}$/i.test(choice)) return setPalette(PALETTES[0].name);
  applyPalette(preset || rampFromHex(choice));
  try {
    localStorage.setItem(PALETTE_STORE, choice);
  } catch (e) {
    // Private browsing, or storage is full. The palette still applies.
  }
}

function storedPalette() {
  try {
    return localStorage.getItem(PALETTE_STORE);
  } catch (e) {
    return null;
  }
}

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

function setup() {
  createCanvas(windowWidth, windowHeight);
  setupRays();
  // The speed wander reads p5's Perlin noise; seed it so a run is reproducible
  // in the same way the traits are.
  noiseSeed(settings.traitSeed);
  strokeCap(ROUND);
  // p5 throttles draw() to 60 by default. 240 lifts the throttle; the real
  // ceiling is the monitor refresh rate, since p5 runs on requestAnimationFrame.
  frameRate(240);

  setPalette(storedPalette() || PALETTES[0].name);

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
  resizeRays();
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

// A gradient rather than a flat background(), and not only because light fades
// with depth. A flat fill of these colours is the one thing an 8-bit canvas
// cannot dim smoothly: BACKGROUND to BACKGROUND_ALARM spans 7 levels of red, 8
// of green and 20 of blue, so a drifting flat fill repaints the whole screen
// every time a channel crosses an integer — 34 times over one ramp, on the
// three channels at unrelated moments, which reads as a hue flicker rather than
// a fade. Smoothing harder only spaces the steps out and makes each one more
// obvious. A gradient turns every crossing into a soft contour that slides down
// the screen instead, and browsers dither gradient fills, so what is left
// dissolves into noise.
//
// Painted through drawingContext because p5's colour objects round to whole
// levels on the way in, which is the precision this is trying to keep.
function paintWater(rgb) {
  const shade = (k) => `rgb(${rgb[0] * k}, ${rgb[1] * k}, ${rgb[2] * k})`;
  const water = drawingContext.createLinearGradient(0, 0, 0, height);
  water.addColorStop(0, shade(WATER_TOP));
  water.addColorStop(1, shade(WATER_BOTTOM));
  drawingContext.fillStyle = water;
  drawingContext.fillRect(0, 0, width, height);
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
  // The menu is HTML, defined in index.html; the sketch only knows the key.
  if ((key === 'c' || key === 'C') && typeof togglePalette === 'function') togglePalette();
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

function draw() {
  // Timestep normalised to the old 60fps baseline: 1 at 60fps, 0.25 at 240fps.
  // Clamped so a backgrounded tab doesn't come back with one giant step that
  // teleports the whole flock.
  const dt = Math.min(deltaTime / (1000 / 60), 3);

  bgPanicSmooth = lerp(bgPanicSmooth, stats.out.panic, 1 - Math.pow(1 - 0.01, dt));
  paintWater([
    lerp(BACKGROUND[0], BACKGROUND_ALARM[0], bgPanicSmooth),
    lerp(BACKGROUND[1], BACKGROUND_ALARM[1], bgPanicSmooth),
    lerp(BACKGROUND[2], BACKGROUND_ALARM[2], bgPanicSmooth),
  ]);

  drawSnow(dt);
  // After the snow, so the shafts add light over the motes inside them and the
  // marine snow catches the light rather than floating in front of it.
  drawRays(bgPanicSmooth);

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
}
