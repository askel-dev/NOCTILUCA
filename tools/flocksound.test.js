// Structural tests for the bell registers. No audio and no simulation — these
// check the note layout itself, which is the thing that quietly went wrong
// before: cohesion and alarm shared one scale, and cohesion's top note landed
// on exactly the same G5 the alarm rang.
//
//   jsc tools/flocksound.test.js
//
// flocksound.js only touches Tone inside method bodies, so it loads fine with
// no audio context anywhere in sight.

load('./flocksound.js');

var fails = 0;
function check(name, cond, detail) {
  if (!cond) fails++;
  print((cond ? 'PASS ' : 'FAIL ') + name + '  ' + detail);
}

var STEP = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midi(n) { return 12 * (parseInt(n.slice(-1), 10) + 1) + STEP[n[0]]; }
function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

var coh = BELL_BANDS.cohesion, alm = BELL_BANDS.alarm;

// --- the bands must be well formed and inside the scale ---
check('bands lie within the scale',
      coh[0] >= 0 && alm[1] <= PENTATONIC.length - 1,
      'scale has ' + PENTATONIC.length + ' notes, bands ' +
      coh[0] + '-' + coh[1] + ' and ' + alm[0] + '-' + alm[1]);
check('bands are ordered low to high', coh[0] < coh[1] && alm[0] < alm[1],
      'cohesion ' + PENTATONIC[coh[0]] + '..' + PENTATONIC[coh[1]] +
      ', alarm ' + PENTATONIC[alm[0]] + '..' + PENTATONIC[alm[1]]);

// --- the separation itself ---
var top = midi(PENTATONIC[coh[1]]), bottom = midi(PENTATONIC[alm[0]]);
check('cohesion sits entirely below alarm', coh[1] < alm[0],
      PENTATONIC[coh[1]] + ' (' + hz(top).toFixed(0) + ' Hz) below ' +
      PENTATONIC[alm[0]] + ' (' + hz(bottom).toFixed(0) + ' Hz)');
check('at least an octave of gap', bottom - top >= 12,
      ((bottom - top) / 12).toFixed(2) + ' octaves between the closest possible pair');

// --- cohesion needs room to move, or density stops meaning anything ---
check('cohesion band is wide enough to place notes in', coh[1] - coh[0] >= 6,
      (coh[1] - coh[0]) + ' steps, ' +
      ((midi(PENTATONIC[coh[1]]) - midi(PENTATONIC[coh[0]])) / 12).toFixed(2) + ' octaves');

// --- the alarm has to cut through, so it must be the top of the scale ---
check('alarm reaches the top of the scale', alm[1] === PENTATONIC.length - 1,
      'top note ' + PENTATONIC[PENTATONIC.length - 1]);

// --- the voice budget has to cover the widest gesture either kind can ask for.
// count is 1+round(density*2) for cohesion and 1+round(panic*1.4) for alarm,
// both at their maximum here.
check('voice cap covers the widest strike', SOUND.maxVoices >= 3 + 2,
      'maxVoices ' + SOUND.maxVoices + ', widest cohesion strike 3 voices');

print(fails ? '\n' + fails + ' FAILED' : '\nALL PASS');
