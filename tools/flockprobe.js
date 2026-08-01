// Measures what the flock statistics actually do, by running the real Boid
// class against a minimal p5 stub. The constants in flockstats.js were read off
// this; re-run it after changing any flocking weight, boid count or speed limit.
//
//   jsc tools/flockprobe.js
//
// (jsc ships with macOS at /System/Library/Frameworks/JavaScriptCore.framework/
// Versions/A/Helpers/jsc — any JS engine with load()/print() will do.)
//
// It runs twice: undisturbed, then with a predator sweeping the canvas the way
// a cursor would. "travel" is mean absolute change per second — the number that
// says whether a channel is alive or static, which percentiles alone will hide.
var TWO_PI = Math.PI * 2;
var width = 1440, height = 900, deltaTime = 1000 / 60;

function Vec(x, y) { this.x = x || 0; this.y = y || 0; }
Vec.prototype.add = function (v) { this.x += v.x; this.y += v.y; return this; };
Vec.prototype.sub = function (v) { this.x -= v.x; this.y -= v.y; return this; };
Vec.prototype.mult = function (n) { this.x *= n; this.y *= n; return this; };
Vec.prototype.div = function (n) { this.x /= n; this.y /= n; return this; };
Vec.prototype.mag = function () { return Math.sqrt(this.x * this.x + this.y * this.y); };
Vec.prototype.setMag = function (n) { var m = this.mag() || 1; this.x = this.x / m * n; this.y = this.y / m * n; return this; };
Vec.prototype.limit = function (n) { var m = this.mag(); if (m > n) { this.x = this.x / m * n; this.y = this.y / m * n; } return this; };
Vec.prototype.heading = function () { return Math.atan2(this.y, this.x); };
function createVector(x, y) { return new Vec(x, y); }
var p5 = { Vector: { random2D: function () { var a = Math.random() * TWO_PI; return new Vec(Math.cos(a), Math.sin(a)); } } };
function random(a, b) {
  if (a === undefined) return Math.random();
  if (b === undefined) return Math.random() * a;
  return a + Math.random() * (b - a);
}

var settings = {
  alignWeight: 1, alignRadius: 50,
  cohesionWeight: 0.9, cohesionRadius: 100,
  separationWeight: 1.5, separationRadius: 30,
  maxSpeed: 4, minSpeed: 2, maxForce: 0.08,
  predatorRadius: 100, predatorWeight: 2.5, predatorMaxForce: 0.7,
};

load('./boids.js');
load('./flockstats.js');

function pct(arr, p) {
  var a = arr.slice().sort(function (x, y) { return x - y; });
  return a[Math.floor(p * (a.length - 1))];
}
function travel(arr) {
  var d = 0;
  for (var i = 1; i < arr.length; i++) d += Math.abs(arr[i] - arr[i - 1]);
  return d / (arr.length / 60);
}
function line(name, arr) {
  print('  ' + name.padEnd(12) +
    'p05 ' + pct(arr, 0.05).toFixed(3) +
    '  p50 ' + pct(arr, 0.5).toFixed(3) +
    '  p95 ' + pct(arr, 0.95).toFixed(3) +
    '  max ' + pct(arr, 1).toFixed(3) +
    '   travel ' + travel(arr).toFixed(3) + '/s');
}

function run(label, withPredator) {
  var flock = [];
  for (var i = 0; i < 200; i++) flock.push(new Boid());
  var stats = new FlockStats();
  var SECONDS = 150;
  var log = { order: [], energy: [], density: [], pan: [], panic: [], alarm: [] };
  var cohesions = 0, alarms = 0;

  for (var f = 0; f < SECONDS * 60; f++) {
    // A cursor wandering the canvas: two incommensurate rates so it never
    // retraces the same path, at roughly the speed of a hand moving a mouse.
    var predator = null;
    if (withPredator) {
      var t = f / 60;
      predator = {
        x: width * (0.5 + 0.42 * Math.sin(t * 0.55)),
        y: height * (0.5 + 0.40 * Math.sin(t * 0.83 + 1.1)),
      };
    }
    for (var b = 0; b < flock.length; b++) {
      flock[b].edges();
      flock[b].flock(flock, predator);
      flock[b].update(1);
    }
    stats.sample(flock, 1 / 60, width, predator);
    if (stats.takeCohesionEvent()) cohesions++;
    if (stats.takeAlarmEvent && stats.takeAlarmEvent()) alarms++;
    if (f > 600) {
      log.order.push(stats.out.order);
      log.energy.push(stats.out.energy);
      log.density.push(stats.out.density);
      log.pan.push(stats.out.centroidX);
      log.panic.push(stats.raw.panic);
      log.alarm.push(stats.raw.alarm === undefined ? 0 : stats.raw.alarm);
    }
  }

  print('=== ' + label + ' (mapped, 150 s) ===');
  line('order', log.order);
  line('energy', log.energy);
  line('density', log.density);
  line('pan', log.pan);
  line('panic raw', log.panic);
  line('alarm raw', log.alarm);
  print('  cohesion strikes: ' + cohesions +
        (cohesions ? '  (one per ' + (150 / cohesions).toFixed(1) + ' s)' : ''));
  print('  alarm strikes:    ' + alarms +
        (alarms ? '  (one per ' + (150 / alarms).toFixed(1) + ' s)' : ''));
  print('');
}

run('UNDISTURBED', false);
run('WITH CURSOR', true);
