// Correctness tests for FlockStats. Plain objects stand in for Boid, so no p5.
//
//   jsc tools/flockstats.test.js
//
// These caught two shipped bugs: a centroid rotated a quarter turn, and an
// auto-range that parked a near-constant channel at zero.

// Harness: FlockStats only reads velocity/position/panic/neighbours, so plain
// objects stand in for Boid and p5 is not needed.
var settings = { maxSpeed: 4, minSpeed: 2 };
load('./flockstats.js');

var W = 1000;
var fails = 0;
function check(name, got, want, tol) {
  var ok = Math.abs(got - want) <= tol;
  if (!ok) fails++;
  print((ok ? 'PASS ' : 'FAIL ') + name + '  got=' + got.toFixed(3) + ' want=' + want.toFixed(3));
}

function makeFlock(n, fn) {
  var f = [];
  for (var i = 0; i < n; i++) f.push(fn(i, n));
  return f;
}
// Settle the stats by feeding the same flock repeatedly.
function settle(s, flock, seconds) {
  for (var t = 0; t < seconds / 0.016; t++) s.sample(flock, 0.016, W);
}

// --- order ---
var aligned = makeFlock(200, function () {
  return { velocity: { x: 3, y: 0 }, position: { x: 500, y: 0 }, panic: 0, neighbours: 10 };
});
var s1 = new FlockStats();
settle(s1, aligned, 1);
check('order: aligned flock', s1.raw.order, 1.0, 0.01);

var scattered = makeFlock(200, function (i, n) {
  var a = (i / n) * Math.PI * 2;
  return { velocity: { x: Math.cos(a) * 3, y: Math.sin(a) * 3 }, position: { x: 500, y: 0 }, panic: 0, neighbours: 10 };
});
var s2 = new FlockStats();
settle(s2, scattered, 1);
check('order: scattered flock', s2.raw.order, 0.0, 0.02);

// --- energy: speed 3 sits halfway between minSpeed 2 and maxSpeed 4 ---
check('energy: mid speed', s1.raw.energy, 0.5, 0.01);

// --- centroid: a tight cluster should pan to its side of the screen ---
function clusterAt(x) {
  return makeFlock(200, function () {
    return { velocity: { x: 3, y: 0 }, position: { x: x }, panic: 0, neighbours: 10 };
  });
}
var sL = new FlockStats();
settle(sL, clusterAt(0.25 * W), 3);
check('centroid: cluster at 25% of width', sL.out.centroidX, -0.5, 0.05);

var sR = new FlockStats();
settle(sR, clusterAt(0.75 * W), 3);
check('centroid: cluster at 75% of width', sR.out.centroidX, 0.5, 0.05);

var sC = new FlockStats();
settle(sC, clusterAt(0.5 * W), 3);
check('centroid: cluster at centre', sC.out.centroidX, 0.0, 0.05);

// A flock spread evenly over a wrapped canvas has no meaningful centroid; the
// resultant-length gate must collapse the pan rather than let it jitter.
var spread = makeFlock(200, function (i, n) {
  return { velocity: { x: 3, y: 0 }, position: { x: (i / n) * W }, panic: 0, neighbours: 10 };
});
var sS = new FlockStats();
settle(sS, spread, 3);
check('centroid: evenly spread collapses to centre', sS.out.centroidX, 0.0, 0.02);

// A cluster straddling the x=0 seam must not fly to the opposite side.
var seam = makeFlock(200, function (i, n) {
  var x = (i < n / 2) ? (0.99 * W + (i / n) * 0.01 * W) : ((i / n) * 0.01 * W);
  return { velocity: { x: 3, y: 0 }, position: { x: x }, panic: 0, neighbours: 10 };
});
var sSeam = new FlockStats();
settle(sSeam, seam, 3);
print('     seam-straddling cluster -> pan ' + sSeam.out.centroidX.toFixed(3) +
      ' (near +/-1, the screen edge, not near 0)');
check('centroid: seam cluster stays at an edge', Math.abs(sSeam.out.centroidX), 1.0, 0.05);

// --- AutoRange: a near-constant signal must still fill the mapped range ---
var flat = new AutoRange(0.05, 0.90, 0.94);
var lastFlat = 0;
for (var i = 0; i < 4000; i++) lastFlat = flat.normalise(0.92 + 0.01 * Math.sin(i / 40), 0.016);
print('     near-constant 0.92+/-0.01 -> mapped ' + lastFlat.toFixed(2) +
      ' over span ' + (flat.hi - flat.lo).toFixed(3) + ' (minSpan 0.05 caps the gain)');
check('autorange: span never collapses below minSpan', Math.max(flat.hi - flat.lo, 0.05), 0.05, 0.02);

// --- cohesion events: now driven by density, with hysteresis + refractory ---
var s3 = new FlockStats();
var events = 0;
for (var step = 0; step < 6000; step++) {
  // Swing neighbour count between loose and tight, ~25 s per cycle (4 cycles).
  var phase = Math.sin(step / 240) * 0.5 + 0.5;
  var nb = 18 + phase * 30;
  var fl = makeFlock(200, function () {
    return { velocity: { x: 3, y: 0 }, position: { x: 500 }, panic: 0, neighbours: nb };
  });
  s3.sample(fl, 0.016, W);
  if (s3.takeCohesionEvent()) events++;
}
print('     4 density cycles over ~96 s -> ' + events + ' strikes');
check('cohesion: one strike per cycle, no machine-gunning', events, 4, 1);

// An alarm rise must fire when fresh boids are startled, and must NOT keep
// firing while the cursor is held still in an already-panicked flock.
var s5 = new FlockStats();
var held = 0, stirred = 0;
function panicFlock(p) {
  return makeFlock(200, function (i, n) {
    return { velocity: { x: 3, y: 0 }, position: { x: 500 },
             panic: i < n * 0.25 ? p : 0, neighbours: 25 };
  });
}
for (var k = 0; k < 600; k++) {           // 10 s of sustained, unchanging panic
  s5.sample(panicFlock(0.6), 0.016, W, { x: 500 });
  if (s5.takeAlarmEvent()) held++;
}
for (var k = 0; k < 600; k++) {           // 10 s of stirring: panic keeps jumping
  s5.sample(panicFlock(k % 90 < 45 ? 0.05 : 0.9), 0.016, W, { x: 500 });
  if (s5.takeAlarmEvent()) stirred++;
}
print('     held still -> ' + held + ' strikes;  stirring -> ' + stirred + ' strikes');
check('alarm: holding still does not keep chiming', held, 1, 1);
check('alarm: stirring keeps chiming', stirred, 8, 5);

// The strike must be placed at the tightest knot, not the flock average.
var knot = makeFlock(200, function (i, n) {
  return { velocity: { x: 3, y: 0 }, position: { x: i === 0 ? 0.9 * W : 0.1 * W },
           panic: 0, neighbours: i === 0 ? 99 : 5 };
});
var s4 = new FlockStats();
s4.sample(knot, 0.016, W);
check('event pan follows the densest boid', s4._tightestX(knot, W), 0.8, 0.01);

print(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
