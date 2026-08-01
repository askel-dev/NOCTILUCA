# NOCTILUCA

Two hundred bioluminescent organisms drifting through dark water, and the sound
they make while doing it.

Open `index.html`. That's the whole thing — no build step, no dependencies to
install. p5.js and Tone.js load from a CDN.

## The aim

This is meant to be restful. Not a demo of the flocking algorithm, not a toy
with a score — something you can leave running on a second monitor, glance at,
and feel calmer for having glanced at.

Everything in here follows from that, and a few of the decisions are only
sensible in that light:

- **There is nothing to do and no way to lose.** No score, no goals, no menus,
  no chrome. Moving the cursor into the flock scatters it, which is the only
  interaction, and it is entirely optional. Watching is a complete use of it.
- **Nothing demands attention.** No flashing, no hard transients, no sudden
  contrast. The boids' glow pulses are individually phase-offset so the school
  shimmers rather than throbbing in unison. Alarm reads as *brighter*, not as a
  colour change — agitated dinoflagellates flash, they do not turn red.
- **The predator is gentle.** Panic ramps from nothing at the edge of its radius
  to full at contact, so boids peel away smoothly instead of snapping, and it
  bleeds off afterwards rather than cutting out. Scattering the flock should
  feel like putting a hand through water, not like scoring a hit.
- **The cursor has no marker.** You never see the thing the flock is fleeing —
  only the flock reacting to it.
- **Sound is never in a hurry.** See below.

## What you see

Deep water, lit only by what is in it. Boids are drawn additively as three
concentric layers — two soft halos and a hot near-white core — so overlapping
glows brighten each other instead of painting over. The core is elongated along
the heading rather than round, because orientation is what makes the flock's
turning legible.

Each organism gets a random depth that scales its size and opacity, so two
hundred identical marks read as a volume of water rather than a flat sheet.
Trails taper to nothing in both width and opacity. Marine snow sinks slowly in
the background. The canvas wraps at the edges, so the flock has nowhere it can
be cornered.

## What you hear

The reference is Austin Wintory's score for *Journey*, and specifically one
principle from it: instruments represent entities in the world, not mood. The
flock should sound like it is *making* the sound, not like music is playing over
it.

So there is **no independent clock**. No transport, no tempo, no loops, no
sequences, no LFOs. Nothing makes a sound that the simulation did not cause, and
a still flock is a silent one. Everything you hear is one of two things:

- **Wind** — a dark, wide bed of filtered noise. Its level follows how fast the
  flock is moving; its brightness and body follow how tightly it is clustered.
  Deliberately capped below the point where it starts to hiss.
- **Bells** — struck pentatonic tones with a 280 ms attack and a long decay, so
  they swell rather than hit. They are silent by default and ring only on
  events. Two kinds, and they sound different on purpose: a *cohesion* chime,
  low and wide, when the flock pulls tight of its own accord; and an *alarm*
  chime, high and tight, when you startle it. They have their own registers and
  the registers never touch — chimes live in E2–C4, alarms in C5–G5, with a full
  octave left empty between them. Each rings from where it happened
  in the stereo field — cohesion from the knot of the flock, alarm from the
  cursor. Both are detected as a *rise* rather than as a level crossing, which
  is what keeps them speaking: a flock that is already dense, or a cursor held
  still in an already-panicked flock, is not doing anything and stays quiet,
  while every fresh tightening gets its own bell. Expect one roughly every
  three seconds, more when you stir the flock.

Audio starts on your first click, because browsers require a gesture before they
will make sound. That is what the title screen is for: the flock is already
swimming behind it, and clicking through both lifts the scrim and opens the
AudioContext. If the audio fails to start the screen still clears and the
simulation runs on, silently.

## Controls

| | |
|---|---|
| move the cursor | scatter the flock |
| click | clear the title screen and start audio |
| `m` | mute |
| `c` | colour menu — six palettes for the flock, or a custom one; the choice is remembered |
| `f` | frame rate |
| `g` | sonification readout — raw flock statistics next to the mapped values the audio hears |

## Files

| | |
|---|---|
| `index.html` | the page — title screen and the tags that load everything else |
| `favicon.svg` | the mark: one cell, a hot core, two trailing filaments |
| `sketch.js` | setup, draw loop, controls |
| `boids.js` | the `Boid` class — flocking rules, panic, rendering |
| `flockstats.js` | turns the flock into five numbers the audio can use |
| `flocksound.js` | the audio engine |
| `sound-sandbox.html` | standalone audition rig — the same synthesis driven by sliders instead of a flock, for trying sounds out without waiting for the sim to do something |
| `tools/` | measurement and tests, below |

## Tuning

The constants in `flockstats.js` are measured, not guessed, and that matters
more than it sounds like it should. Aggregate flock statistics do not behave the
way the individual boids do: mean speed here is nearly a flat line because every
steering rule pushes toward `maxSpeed`, and alignment sits above 0.87 essentially
always, so neither is much use as an expressive signal. How tightly the flock is
clustered is the one continuous quantity with real range, and it does most of
the work.

If you change a flocking weight, the boid count or the speed limits, those
distributions move and the sound will drift out of tune with the simulation.

```
jsc tools/flockprobe.js        # print what the statistics actually do, over 150s,
                               # undisturbed and with a cursor sweeping the flock
jsc tools/flockstats.test.js   # correctness tests
```

`jsc` ships with macOS at
`/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc`;
any JS engine with `load()` and `print()` works.
