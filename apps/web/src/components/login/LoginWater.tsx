import { useEffect, useRef } from 'react'

/*
 * The water under the sign-in form. "Sillage" is the trail a boat leaves on the water: rows of
 * water swell gently, glints flicker in the reflection under the form, and now and then a point
 * crosses and leaves a wake. The pointer can take the helm. Purely decorative.
 *
 * The wake uses the physics and tuning of the website's hero (site/wake.js): a small height field
 * advanced by the wave equation at a fixed time step, so the motion stays fluid at any frame rate,
 * pushed by a source faster than the waves, which folds them into a V by itself. What differs is
 * the drawing: rows are laid out in perspective, bunched up toward the horizon and spread toward
 * the viewer, so the strip reads as a lake seen from its shore. The simulation stays on its flat
 * grid; only row positions and wave heights are projected. The swell is added at drawing time.
 */

const DX = 7 // px between samples along a row
const DY = 12 // px between rows of the flat grid
const STEP = 1 / 120 // s of simulated time per step
const WAVE_SPEED = 92 // px/s
const BOAT_SPEED = 245 // px/s, well above the wave speed: that is what makes the V
const HALF_LIFE = 2 // s for a wave to lose half its height
const BOW = 15 // px, radius of the push under the boat
const PUSH = 0.15 // px of height added per step under the bow
const POINTER_DAB = 5 // px between two pushes along the pointer's path
const POINTER_PUSH = 0.035 // px per step of vertical speed, per px travelled
const POINTER_RISE = 0.065 // px of height given immediately, per px travelled
const DROP = 2.6 // px of height given at once where the water is tapped
const EDGE = 9 // cells of sponge that stop waves bouncing off the sides
const FIRST_PASS_AT = 0.5 // s, so the wake shows while the page is being looked at
const CALM_BETWEEN_PASSES = 10 // s
const MAX_LIFT = 9 // px, on the flat grid
// Height at which a stretch of row takes the wake colour, and how strongly.
const LEVELS = [0.45, 1, 1.9, 3.1]
const ALPHAS = [0.2, 0.4, 0.66, 0.95]
const WIDTHS = [1, 1.05, 1.2, 1.35]
// Turns a cell's vertical speed into the height it is about to reach, so a wave keeps its colour
// while it crosses zero instead of blinking.
const SWING = 9

// Swell: long waves rolling toward the viewer, so the sea never stands still. Heights in px of the
// flat grid, wavelengths across (px, negative to roll the other way) and toward the viewer (rows),
// speeds in rad/s. Added at drawing time only: the swell takes no wake colour and leaves the
// boat's V alone.
const SWELL = [
  { height: 0.95, across: 1100, toward: 7, speed: 1 },
  { height: 0.45, across: -380, toward: 13, speed: 0.7 },
  { height: 0.2, across: 160, toward: 4, speed: 2.1 },
]
// Wave faces steep enough to catch the light rise one sheen level: bright bands that roll toward
// the viewer with the swell. Slope in px of height per row.
const FACING = 0.5
// The sea moves while someone is at the page: until this long after the last pointer move, key
// or return to the tab. Then the swell settles over FADE and the loop stops, until the next one.
const AWAKE = 120 // s
const FADE = 4 // s
// Frames drawn per second at most: the swell alone is slow enough for half the rate a wake needs,
// which halves the cost of a page that mostly sits there. A 120 Hz screen gets no more than 60.
const SWELL_FPS = 30
const WAKE_FPS = 60

// Perspective. Row r of n sits at height · ((r + 1) / (n + 1)) ^ DEPTH_CURVE below the horizon.
const DEPTH_CURVE = 2.3
const ROW_PX = 9 // average px per drawn row, which sets how many rows a strip gets
const MIN_ROWS = 14
const MAX_ROWS = 44
// Rows are stroked in depth bands, the far ones fainter and finer, like water losing detail.
const BANDS = 6
const CALM_FAR = 0.05
const CALM_NEAR = 0.2
// Still water catches the light unevenly: each row brightens and fades along its length, in
// patches that lengthen toward the viewer. Opacity of each patch level, as a share of the row's.
const SHEEN = [0.12, 0.4, 0.72, 1]
const SHEEN_KNOT = [5, 24] // columns between two sheen values, farthest and nearest row
// Under the form, a path of short glints in the accent colour, the way a light low on the horizon
// is reflected toward whoever looks at it: denser in the middle, wider toward the viewer.
const PATH_WIDTH = [0.03, 0.15] // half-width of the path, as a share of the strip's width (≤ 1200 px)
const PATH_DENSITY = 0.2 // chance that a glint starts on a cell in the middle of the path
const PATH_RUN = [1, 6] // columns a glint lasts at most, farthest and nearest row
// Each glint pulses at its own pace, dim most of the time with brief flashes: the glitter.
const TWINKLE = [1.4, 3.4] // rad/s, slowest and fastest
const GLINT = [1 / 6, 2 / 6, 3 / 6, 4 / 6, 5 / 6, 1] // opacity steps, as a share of the wake's strongest
const GLINT_WIDTH = 1.6 // glints are drawn over their row, thicker and with rounded ends, like light

interface Spot {
  x: number
  /** Row on the flat grid, fractional. */
  row: number
}

interface Pass {
  started: number
  duration: number
  at: (progress: number) => Spot
}

export default function LoginWater() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !context) return
    return runWater(canvas, context)
  }, [])
  // The canvas carries the two colours it draws with (ink and accent), read from its computed style.
  return <canvas ref={canvasRef} aria-hidden className="sg-login-water block size-full text-ink decoration-accent" />
}

/** Small deterministic generator (mulberry32), enough to lay out strokes. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function runWater(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): () => void {
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const kx = ((WAVE_SPEED * STEP) / DX) ** 2
  const ky = ((WAVE_SPEED * STEP) / DY) ** 2
  const damping = 0.5 ** (STEP / HALF_LIFE)
  // The grid starts off screen, so the sponge at its sides never shows.
  const originX = -EDGE * DX

  let width = 0
  let height = 0
  let cols = 0
  let rows = 0
  let drawnRows = 0
  let level = new Float32Array(0) // height of each cell, px
  let speed = new Float32Array(0) // its vertical speed, px per step
  let sponge = new Float32Array(0)
  let rowY = new Float32Array(0) // where each drawn row sits on screen
  let rowLift = new Float32Array(0) // screen px of displacement for MAX_LIFT on the grid
  let rowBand = new Uint8Array(0)
  // Swell, split into a part per row (fixed) and a part per column (moves with time), whose sum
  // the angle formulas join: sin(a + b) = sin a cos b + cos a sin b.
  let rowSin = new Float32Array(0)
  let rowCos = new Float32Array(0)
  let colSin = new Float32Array(0)
  let colCos = new Float32Array(0)
  let sheen = new Uint8Array(0) // light level of still water per grid cell
  // Reflection: per cell, the brightest a glint gets (0 where there is none), its pace and phase.
  let glintPeak = new Float32Array(0)
  let glintPace = new Float32Array(0)
  let glintPhase = new Float32Array(0)
  let ink = '#000'
  let wake = '#00f'
  let pass: Pass | null = null
  let passCount = 0
  let clock = 0 // simulated seconds
  let nextPassAt = FIRST_PASS_AT
  // On the page's clock, not the simulation's: the sea settles after real minutes of absence.
  let awakeUntil = performance.now() + AWAKE * 1000
  let awake = true
  let swell = 1 // how much of the swell shows, 0 to 1
  let helm: Spot | null = null // where the pointer's push currently is
  let aim: Spot | null = null // where the pointer is
  let stirred = 0 // highest wave seen in the last frame
  let frame = 0
  let lastTime = 0
  let lastDrawn = 0
  let pending = 0

  function readColors() {
    const style = getComputedStyle(canvas)
    ink = style.color || ink
    wake = style.textDecorationColor || wake
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    const ratio = Math.min(devicePixelRatio || 1, 2)
    width = bounds.width
    height = bounds.height
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    drawnRows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.round(height / ROW_PX)))
    // Rows below the bottom edge hold that side's sponge, out of sight like the others.
    rows = drawnRows + EDGE
    cols = Math.ceil(width / DX) + 2 * EDGE + 1
    level = new Float32Array(cols * rows)
    speed = new Float32Array(cols * rows)
    sponge = new Float32Array(cols * rows)
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const depth = Math.min(col, row, cols - 1 - col, rows - 1 - row)
        sponge[row * cols + col] = depth >= EDGE ? damping : damping * (0.9 + (0.1 * depth) / EDGE)
      }
    }
    rowY = new Float32Array(drawnRows)
    rowLift = new Float32Array(drawnRows)
    rowBand = new Uint8Array(drawnRows)
    rowSin = new Float32Array(drawnRows * SWELL.length)
    rowCos = new Float32Array(drawnRows * SWELL.length)
    colSin = new Float32Array(cols * SWELL.length)
    colCos = new Float32Array(cols * SWELL.length)
    for (let row = 0; row < drawnRows; row++) {
      const near = (row + 1) / (drawnRows + 1)
      rowY[row] = height * near ** DEPTH_CURVE
      // Waves scale with the gap to the next row, so near ones swell and far ones never cross.
      const gap = (height * DEPTH_CURVE * near ** (DEPTH_CURVE - 1)) / (drawnRows + 1)
      rowLift[row] = (MAX_LIFT * gap) / DY
      rowBand[row] = Math.min(BANDS - 1, Math.floor(near * BANDS))
      SWELL.forEach((wave, index) => {
        const angle = (2 * Math.PI * row) / wave.toward
        rowSin[row * SWELL.length + index] = Math.sin(angle)
        rowCos[row * SWELL.length + index] = Math.cos(angle)
      })
    }
    // Smooth noise along each row: random values at knots, eased in between. A fixed seed, so the
    // light falls the same way on every visit.
    sheen = new Uint8Array(drawnRows * cols)
    glintPeak = new Float32Array(drawnRows * cols)
    glintPace = new Float32Array(drawnRows * cols)
    glintPhase = new Float32Array(drawnRows * cols)
    const random = seeded(drawnRows * 7919 + cols)
    for (let row = 0; row < drawnRows; row++) {
      const near = (row + 1) / (drawnRows + 1)
      const knot = Math.round(SHEEN_KNOT[0]! + (SHEEN_KNOT[1]! - SHEEN_KNOT[0]!) * near ** 1.5)
      const spread = Math.min(width, 1200) * (PATH_WIDTH[0]! + (PATH_WIDTH[1]! - PATH_WIDTH[0]!) * near ** 1.2)
      let from = random()
      let to = random()
      const phase = Math.floor(random() * knot)
      for (let col = 0; col < cols; col++) {
        const along = (col + phase) % knot
        if (along === 0 && col > 0) {
          from = to
          to = random()
        }
        const value = from + (to - from) * (0.5 - 0.5 * Math.cos((Math.PI * along) / knot))
        sheen[row * cols + col] = Math.min(SHEEN.length - 1, Math.floor(value ** 1.3 * SHEEN.length))
      }
      const longest = Math.round(PATH_RUN[0]! + (PATH_RUN[1]! - PATH_RUN[0]!) * near ** 1.5)
      for (let col = 0; col < cols; col++) {
        const offPath = (originX + col * DX - width / 2) / spread
        if (random() >= PATH_DENSITY * Math.exp(-offPath * offPath)) continue
        // The brightest glints keep to the middle of the path.
        const peak = random() < Math.exp(-2 * offPath * offPath) ? 1 : 0.55
        const pace = TWINKLE[0]! + (TWINKLE[1]! - TWINKLE[0]!) * random()
        const start = 2 * Math.PI * random()
        const end = row * cols + Math.min(cols, col + 1 + Math.floor(random() * longest))
        glintPeak.fill(peak, row * cols + col, end)
        glintPace.fill(pace, row * cols + col, end)
        glintPhase.fill(start, row * cols + col, end)
        col = end - row * cols
      }
    }
    pass = null
    helm = null
    aim = null
  }

  /** Grid row under a point of the canvas, the inverse of the perspective. */
  function rowAt(y: number): number {
    return (drawnRows + 1) * Math.max(0, y / height) ** (1 / DEPTH_CURVE) - 1
  }

  // Each pass crosses the whole strip on a slant, alternately coming closer and going away.
  function course(index: number): Omit<Pass, 'started'> {
    const forward = index % 2 === 0
    const far = drawnRows * 0.3
    const near = drawnRows * 0.72
    const start = { x: forward ? -40 : width + 40, row: forward ? far : near }
    const end = { x: forward ? width + 60 : -60, row: forward ? near : far }
    const length = Math.hypot(end.x - start.x, (end.row - start.row) * DY)
    const sway = (near - far) * 0.12
    return {
      duration: length / BOAT_SPEED,
      at(progress) {
        return {
          x: start.x + (end.x - start.x) * progress,
          row: start.row + (end.row - start.row) * progress + Math.sin(progress * Math.PI * 2) * sway,
        }
      },
    }
  }

  // Lift the water under a point and lower it around, so that no water is added overall and the
  // surface comes back to rest at its own level. `now` is height given at once, for a push that
  // must show the instant it is made.
  function push(spot: Spot, amount: number, now = 0) {
    const y = spot.row * DY
    const reach = BOW * 3
    const firstCol = Math.max(1, Math.floor((spot.x - reach - originX) / DX))
    const lastCol = Math.min(cols - 2, Math.ceil((spot.x + reach - originX) / DX))
    const firstRow = Math.max(1, Math.floor((y - reach) / DY))
    const lastRow = Math.min(rows - 2, Math.ceil((y + reach) / DY))
    for (let row = firstRow; row <= lastRow; row++) {
      const dy = row * DY - y
      for (let col = firstCol; col <= lastCol; col++) {
        const dx = originX + col * DX - spot.x
        const q = (dx * dx + dy * dy) / (2 * BOW * BOW)
        const shape = (1 - q) * Math.exp(-q)
        const index = row * cols + col
        speed[index] = speed[index]! - amount * shape
        if (now) level[index] = level[index]! - now * shape
      }
    }
  }

  function step() {
    clock += STEP
    if (pass) {
      const progress = (clock - pass.started) / pass.duration
      if (progress > 1) {
        pass = null
        nextPassAt = clock + CALM_BETWEEN_PASSES
      } else {
        // Ease in and out so the boat neither appears nor vanishes abruptly.
        push(pass.at(progress), PUSH * Math.min(1, progress * 8, (1 - progress) * 8))
      }
    } else if (!aim && awake && clock >= nextPassAt) {
      pass = { ...course(passCount++), started: clock }
    }
    if (aim) {
      if (!helm) helm = { ...aim }
      const dx = aim.x - helm.x
      const dy = (aim.row - helm.row) * DY
      const distance = Math.hypot(dx, dy)
      // The water answers under the pointer in the same step: the whole stretch it just crossed
      // is pushed at once, a dab every few pixels so that a fast flick still draws one line.
      if (distance > 0.5) {
        const dabs = Math.ceil(distance / POINTER_DAB)
        const share = distance / dabs
        for (let dab = 1; dab <= dabs; dab++) {
          const spot = { x: helm.x + (dx * dab) / dabs, row: helm.row + (aim.row - helm.row) * (dab / dabs) }
          push(spot, POINTER_PUSH * share, POINTER_RISE * share)
        }
        helm = { ...aim }
      }
    }
    for (let row = 1; row < rows - 1; row++) {
      const offset = row * cols
      for (let index = offset + 1; index < offset + cols - 1; index++) {
        const here = level[index]!
        speed[index] =
          (speed[index]! +
            kx * (level[index - 1]! + level[index + 1]! - 2 * here) +
            ky * (level[index - cols]! + level[index + cols]! - 2 * here)) *
          sponge[index]!
      }
    }
    for (let index = 0; index < level.length; index++) level[index] = level[index]! + speed[index]!
  }

  function draw() {
    context.clearRect(0, 0, width, height)
    const calm = Array.from({ length: BANDS }, () => SHEEN.map(() => new Path2D()))
    const shine = Array.from({ length: BANDS }, () => GLINT.map(() => new Path2D()))
    const bright = Array.from({ length: BANDS }, () => LEVELS.map(() => new Path2D()))
    // Only the columns on screen are drawn; the rest of the grid is sponge.
    const firstCol = EDGE - 1
    const lastCol = Math.min(cols - 1, EDGE + Math.ceil(width / DX) + 1)
    for (let col = firstCol; col <= lastCol; col++) {
      SWELL.forEach((wave, index) => {
        const angle = (2 * Math.PI * (originX + col * DX)) / wave.across - wave.speed * clock + index
        colSin[col * SWELL.length + index] = Math.sin(angle)
        colCos[col * SWELL.length + index] = Math.cos(angle)
      })
    }
    let highest = 0
    for (let row = 0; row < drawnRows; row++) {
      const offset = row * cols
      const baseY = rowY[row]! + 0.5
      const lift = rowLift[row]!
      const band = rowBand[row]!
      let previousX = 0
      let previousY = 0
      let previousSize = 0
      let previousPath: Path2D | null = null
      let previousShine: Path2D | null = null
      for (let col = firstCol; col <= lastCol; col++) {
        const surface = level[offset + col]!
        const size = Math.hypot(surface, speed[offset + col]! * SWING)
        let rolling = 0
        let facing = 0
        if (swell) {
          for (let index = 0; index < SWELL.length; index++) {
            const wave = SWELL[index]!
            const r = row * SWELL.length + index
            const c = col * SWELL.length + index
            rolling += wave.height * (rowSin[r]! * colCos[c]! + rowCos[r]! * colSin[c]!)
            facing += ((wave.height * 2 * Math.PI) / wave.toward) * (rowCos[r]! * colCos[c]! - rowSin[r]! * colSin[c]!)
          }
        }
        const x = originX + col * DX
        // A soft ceiling: tall waves round off instead of flattening.
        const y = baseY + lift * Math.tanh((surface + swell * rolling) / MAX_LIFT)
        if (col > firstCol) {
          const strength = Math.max(size, previousSize)
          if (strength > highest) highest = strength
          const light = sheen[offset + col]! + (swell * facing > FACING ? 1 : 0)
          let path = calm[band]![Math.min(SHEEN.length - 1, light)]!
          for (let index = LEVELS.length - 1; index >= 0; index--) {
            if (strength >= LEVELS[index]!) {
              path = bright[band]![index]!
              break
            }
          }
          // Continue the line while it stays in one stroke: joints are then neither doubled
          // where two strokes' caps overlap nor broken.
          if (path !== previousPath) path.moveTo(previousX, previousY)
          path.lineTo(x, y)
          previousPath = path
          // A glint shows on still water only: a passing wave takes the light with it.
          let shining: Path2D | null = null
          const peak = glintPeak[offset + col]!
          if (peak && strength < LEVELS[0]!) {
            const pulse = 0.5 + 0.5 * Math.sin(glintPace[offset + col]! * clock + glintPhase[offset + col]!)
            const flash = Math.ceil(peak * pulse * pulse * GLINT.length) - 1
            if (flash >= 0) shining = shine[band]![flash]!
          }
          if (shining) {
            if (shining !== previousShine) shining.moveTo(previousX, previousY)
            shining.lineTo(x, y)
          }
          previousShine = shining
        }
        previousX = x
        previousY = y
        previousSize = size
      }
    }
    stirred = highest
    // Butt caps for the rows: two strokes that meet end to end must not overlap, or each joint
    // shows as a dot.
    context.lineJoin = 'round'
    for (let band = 0; band < BANDS; band++) {
      const near = (band + 0.5) / BANDS
      const thickness = 0.75 + 0.5 * near
      context.lineCap = 'butt'
      context.lineWidth = thickness
      context.strokeStyle = ink
      calm[band]!.forEach((path, index) => {
        context.globalAlpha = (CALM_FAR + (CALM_NEAR - CALM_FAR) * near) * SHEEN[index]!
        context.stroke(path)
      })
      context.strokeStyle = wake
      bright[band]!.forEach((path, index) => {
        context.globalAlpha = ALPHAS[index]! * (0.45 + 0.55 * near)
        context.lineWidth = WIDTHS[index]! * thickness
        context.stroke(path)
      })
      // Over the row rather than in it, so their rounded ends overlap nothing of their own.
      context.lineCap = 'round'
      context.lineWidth = GLINT_WIDTH * thickness
      shine[band]!.forEach((path, index) => {
        context.globalAlpha = ALPHAS[ALPHAS.length - 1]! * GLINT[index]! * (0.25 + 0.75 * near)
        context.stroke(path)
      })
    }
    context.globalAlpha = 1
    // The stylesheet fades the water in once there is something to show.
    canvas.dataset.ready = ''
  }

  function tick(time: number) {
    frame = 0
    // A tab that was away comes back to a long gap: resume, do not replay it.
    const elapsed = Math.min(0.05, Math.max(0, (time - lastTime) / 1000))
    lastTime = time
    pending += elapsed
    // The swell comes up while someone is at the page and settles once they have gone.
    awake = time < awakeUntil
    swell += Math.max(-elapsed / FADE, Math.min(elapsed / FADE, (awake ? 1 : 0) - swell))
    while (pending >= STEP) {
      step()
      pending -= STEP
    }
    const calm = !pass && !aim && stirred < LEVELS[0]! * 0.5
    // A frame early by less than a millisecond or two still counts, or 60 Hz would draw at 20.
    if (time - lastDrawn >= 1000 / (calm ? SWELL_FPS : WAKE_FPS) - 2) {
      lastDrawn = time
      draw()
    }
    // Settled and nobody around: stop until the next sign of life starts the loop again.
    if (calm && !swell) return
    schedule()
  }

  function schedule() {
    if (frame || document.hidden || reducedMotion.matches || !width) return
    lastTime = performance.now()
    frame = requestAnimationFrame((time) => {
      lastTime = Math.min(lastTime, time)
      tick(time)
    })
  }

  // Without motion, show the wake as it stands when the boat is most of the way across, on a
  // swell caught in the same instant.
  function drawStill() {
    level.fill(0)
    speed.fill(0)
    aim = null
    clock = 0
    swell = 1
    pass = { ...course(0), started: 0 }
    const until = pass.duration * 0.8
    while (clock < until) step()
    pass = null
    draw()
  }

  function refresh() {
    if (!width) return
    readColors()
    if (reducedMotion.matches) drawStill()
    else draw()
    schedule()
  }

  function spotAt(event: PointerEvent): Spot {
    const bounds = canvas.getBoundingClientRect()
    return { x: event.clientX - bounds.left, row: rowAt(event.clientY - bounds.top) }
  }

  // Someone is at the page: keep the sea moving, or bring it back.
  const onPresence = () => {
    if (document.hidden || reducedMotion.matches) return
    awakeUntil = performance.now() + AWAKE * 1000
    schedule()
  }
  const onPointerMove = (event: PointerEvent) => {
    if (reducedMotion.matches || event.pointerType === 'touch') return
    aim = spotAt(event)
    // The visitor is steering; hold the next unattended pass back.
    pass = null
    schedule()
  }
  const onPointerLeave = () => {
    aim = null
    helm = null
    nextPassAt = clock + CALM_BETWEEN_PASSES
  }
  // A tap drops a single ring where it lands: on a phone, the only way to touch the water.
  const onPointerDown = (event: PointerEvent) => {
    if (reducedMotion.matches) return
    push(spotAt(event), 0, DROP)
    stirred = Math.max(stirred, LEVELS[0]!)
    schedule()
  }
  const onMotionChange = () => {
    level.fill(0)
    speed.fill(0)
    pass = null
    clock = 0
    nextPassAt = FIRST_PASS_AT
    awakeUntil = performance.now() + AWAKE * 1000
    refresh()
  }

  canvas.addEventListener('pointermove', onPointerMove, { passive: true })
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('pointerdown', onPointerDown)
  for (const type of ['pointermove', 'pointerdown', 'keydown'] as const) window.addEventListener(type, onPresence, { passive: true })
  document.addEventListener('visibilitychange', onPresence)
  reducedMotion.addEventListener('change', onMotionChange)
  const sized = new ResizeObserver(() => {
    resize()
    refresh()
  })
  sized.observe(canvas)
  // Theme and hue live on <html>: follow them like the rest of the page.
  const themed = new MutationObserver(refresh)
  themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })

  return () => {
    cancelAnimationFrame(frame)
    sized.disconnect()
    themed.disconnect()
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerleave', onPointerLeave)
    canvas.removeEventListener('pointerdown', onPointerDown)
    for (const type of ['pointermove', 'pointerdown', 'keydown'] as const) window.removeEventListener(type, onPresence)
    document.removeEventListener('visibilitychange', onPresence)
    reducedMotion.removeEventListener('change', onMotionChange)
  }
}
