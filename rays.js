// Volumetric light shafts descending through the water column.
//
// The scene had no top before this. A flat gradient reads as dark but not as
// deep — nothing tells the eye where the surface is, so the flock could be
// swimming in ink. A few wide, heavily feathered shafts give the water a
// source and a direction, and the flock something to swim beneath.
//
// The hard part here is not the geometry, it is banding. Large near-black
// low-contrast gradients are exactly the case paintWater() was written to
// survive, and the same rule applies: paint through drawingContext gradients,
// which browsers dither, rather than stacking translucent shapes, which
// contour visibly against water this dark.

const RAY_COUNT = 5;

// The shafts live on their own buffer at a quarter of the canvas in each
// dimension. Two reasons, both load-bearing: sixteen times less fill per
// frame, which matters at the 240fps the sketch asks for; and scaling the
// buffer back up on composite runs it through bilinear filtering, which is a
// free blur. Volumetric light wants to be blurrier than canvas draws natively.
const RAY_SCALE = 4;

// Overall strength of the light, and how much of a lift full panic adds. The
// lift has to stay small for the same reason bgPanicSmooth drifts rather than
// tracks: this is mood, not a meter. If you can tell it is reacting, it is
// too high.
const RAY_ALPHA = 0.055;
const RAY_PANIC_LIFT = 0.35;

// Same family as the HUD accent and the splash --glow. Blue carries furthest
// through water, so the feathered edges run bluer than the core.
const RAY_CORE = [150, 225, 255];
const RAY_EDGE = [96, 178, 255];

// Fraction of the canvas height the light reaches before it is gone. Nearly
// the full height: cut it short and the shafts stop reading as light coming
// down through a column and start reading as a glow stuck to the top edge.
const RAY_REACH = 0.94;

let rayLayer = null;
let rays = [];
// The source sits off the top of the canvas, left of centre. Everything fans
// from this one point, which is what makes the shafts read as one sun rather
// than as five unrelated streaks.
let raySource = { x: 0, y: 0 };

function setupRays() {
  rayLayer = createGraphics(
    Math.max(1, Math.ceil(width / RAY_SCALE)),
    Math.max(1, Math.ceil(height / RAY_SCALE))
  );
  buildRays();
}

function resizeRays() {
  rayLayer.resizeCanvas(
    Math.max(1, Math.ceil(width / RAY_SCALE)),
    Math.max(1, Math.ceil(height / RAY_SCALE))
  );
  buildRays();
}

// Widths and lengths are stored in layer pixels, so everything downstream
// works in one coordinate system and only the composite scales back up.
function buildRays() {
  const lw = rayLayer.width;
  const lh = rayLayer.height;

  // High above the canvas and near centre. Height matters as much as the fan
  // angle: a source close to the top edge throws a spotlight cone, while one
  // this far up gives shafts that are nearly parallel by the time they enter
  // frame — which is what sunlight through a surface actually looks like.
  raySource = { x: lw * 0.5, y: -lh * 0.9 };
  // Far enough past the bottom of the canvas that the depth mask, not the end
  // of the geometry, is what stops the light. The outermost shafts travel
  // 1/cos(30°) further than the centre one to reach the same depth, and the
  // sway tilts them further still, so this carries plenty of slack.
  const reach = lh * 2.8;

  rays = [];
  for (let i = 0; i < RAY_COUNT; i++) {
    // Fanned across the source rather than randomly placed: evenly spaced with
    // a jitter, so they neither line up nor clump.
    const spread = (i / (RAY_COUNT - 1) - 0.5) * 2;
    rays.push({
      angle: spread * radians(30) + random(-0.05, 0.05),
      // Two periods that do not divide into each other, so the sway never
      // settles into an obvious loop.
      swayA: random(0.000045, 0.000075),
      swayB: random(0.000021, 0.000034),
      phaseA: random(TWO_PI),
      phaseB: random(TWO_PI),
      amp: radians(random(1.4, 2.6)),
      topWidth: lw * random(0.04, 0.07),
      bottomWidth: lw * random(0.34, 0.52),
      length: reach,
      gain: random(0.7, 1),
    });
  }
}

// Called between the marine snow and the flock, in BLEND mode. Everything here
// goes through drawingContext and is restored on the way out, so p5's own
// blend state is untouched.
function drawRays(panic) {
  const ctx = rayLayer.drawingContext;
  const lw = rayLayer.width;
  const lh = rayLayer.height;

  // clearRect, not a fill: the layer has to stay transparent everywhere the
  // light is not, or the composite would add a wash over the whole canvas.
  ctx.clearRect(0, 0, lw, lh);

  const t = millis();
  for (const ray of rays) {
    const sway =
      ray.amp *
      (0.65 * sin(t * ray.swayA + ray.phaseA) + 0.35 * sin(t * ray.swayB + ray.phaseB));

    ctx.save();
    ctx.translate(raySource.x, raySource.y);
    ctx.rotate(ray.angle + sway);

    const half = ray.bottomWidth / 2;
    // The gradient spans the widest part of the wedge, not each slice of it.
    // The narrow top therefore samples only the bright centre and the wide
    // bottom samples the full feathered bell — crisp near the source,
    // dissolving at reach, without a second gradient axis.
    const across = ctx.createLinearGradient(-half, 0, half, 0);
    const core = (a) => `rgba(${RAY_CORE[0]}, ${RAY_CORE[1]}, ${RAY_CORE[2]}, ${a})`;
    const edge = (a) => `rgba(${RAY_EDGE[0]}, ${RAY_EDGE[1]}, ${RAY_EDGE[2]}, ${a})`;
    across.addColorStop(0, edge(0));
    across.addColorStop(0.28, edge(0.22 * ray.gain));
    across.addColorStop(0.5, core(ray.gain));
    across.addColorStop(0.72, edge(0.22 * ray.gain));
    across.addColorStop(1, edge(0));

    ctx.fillStyle = across;
    ctx.beginPath();
    ctx.moveTo(-ray.topWidth / 2, 0);
    ctx.lineTo(ray.topWidth / 2, 0);
    ctx.lineTo(ray.bottomWidth / 2, ray.length);
    ctx.lineTo(-ray.bottomWidth / 2, ray.length);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // One mask over the finished layer fades every shaft together, which is both
  // cheaper than baking a depth axis into each wedge and more consistent —
  // the light dies at one depth rather than five.
  ctx.globalCompositeOperation = 'destination-out';
  const depth = ctx.createLinearGradient(0, 0, 0, lh * RAY_REACH);
  depth.addColorStop(0, 'rgba(0, 0, 0, 0)');
  depth.addColorStop(0.55, 'rgba(0, 0, 0, 0.55)');
  depth.addColorStop(1, 'rgba(0, 0, 0, 1)');
  ctx.fillStyle = depth;
  ctx.fillRect(0, 0, lw, lh);
  ctx.globalCompositeOperation = 'source-over';

  drawingContext.save();
  drawingContext.globalCompositeOperation = 'lighter';
  drawingContext.globalAlpha = RAY_ALPHA * (1 + RAY_PANIC_LIFT * panic);
  drawingContext.drawImage(rayLayer.elt, 0, 0, width, height);
  drawingContext.restore();
}
