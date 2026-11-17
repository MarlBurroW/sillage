// The hero's wake. "Sillage" is the French word for the trail a boat leaves on
// the water: rows of still water are disturbed by a point that crosses them,
// then settle. The pointer can take the helm. Purely decorative.
//
// The water is a small height field advanced by the wave equation at a fixed
// time step, so the motion stays fluid whatever the display's frame rate. A
// source that travels faster than the waves folds them into a V by itself.
(() => {
  const canvas = document.querySelector('[data-wake]')
  const hero = canvas?.closest('.hero')
  const context = canvas?.getContext('2d')
  if (!hero || !context) return

  const DX = 7 // px between samples along a row
  const DY = 12 // px between rows of water
  const STEP = 1 / 120 // s of simulated time per step
  const WAVE_SPEED = 92 // px/s
  const BOAT_SPEED = 245 // px/s, well above the wave speed: that is what makes the V
  const HALF_LIFE = 2 // s for a wave to lose half its height
  const BOW = 15 // px, radius of the push under the boat
  const PUSH = 0.15 // px of height added per step under the bow
  const POINTER_DAB = 5 // px between two pushes along the pointer's path
  const POINTER_PUSH = 0.035 // px per step of vertical speed, per px travelled
  const POINTER_RISE = 0.065 // px of height given immediately, per px travelled
  const EDGE = 9 // cells of sponge that stop waves bouncing off the sides
  const CALM_BETWEEN_PASSES = 6 // s
  const MAX_LIFT = 9 // px
  // Height at which a stretch of row takes the wake colour, and how strongly.
  const LEVELS = [0.45, 1, 1.9, 3.1]
  const ALPHAS = [0.2, 0.4, 0.66, 0.95]
  const WIDTHS = [1, 1.05, 1.2, 1.35]
  // Turns a cell's vertical speed into the height it is about to reach, so a
  // wave keeps its colour while it crosses zero instead of blinking.
  const SWING = 9

  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const kx = (WAVE_SPEED * STEP / DX) ** 2
  const ky = (WAVE_SPEED * STEP / DY) ** 2
  const damping = 0.5 ** (STEP / HALF_LIFE)

  let width = 0
  let height = 0
  let originX = 0
  let originY = 0
  let cols = 0
  let rows = 0
  let level = new Float32Array(0) // height of each cell, px
  let speed = new Float32Array(0) // its vertical speed, px per step
  let sponge = new Float32Array(0)
  let ink = '#000'
  let wake = '#00f'
  let pass = null
  let passCount = 0
  let clock = 0 // simulated seconds
  let nextPassAt = 0.4
  let helm = null // where the pointer's push currently is
  let aim = null // where the pointer is
  let stirred = 0 // highest wave seen in the last frame
  let frame = 0
  let lastTime = 0
  let pending = 0
  let visible = false

  function readColors() {
    const style = getComputedStyle(document.documentElement)
    ink = style.getPropertyValue('--ink').trim() || ink
    wake = style.getPropertyValue('--wake').trim() || wake
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect()
    const ratio = Math.min(devicePixelRatio || 1, 2)
    width = bounds.width
    height = bounds.height
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    // Only the water the stylesheet's mask lets through is simulated: right of
    // the text on wide screens, the band kept clear below it on narrow ones.
    const narrow = width < 850
    originX = narrow ? 0 : Math.floor(width * 0.34)
    originY = narrow ? Math.max(0, Math.floor(height - 200)) : Math.floor(height * 0.24)
    cols = Math.ceil((width - originX) / DX) + 2
    rows = Math.max(3, Math.ceil((height - originY) / DY) + 1)
    level = new Float32Array(cols * rows)
    speed = new Float32Array(cols * rows)
    sponge = new Float32Array(cols * rows)
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const depth = Math.min(col, row, cols - 1 - col, rows - 1 - row)
        sponge[row * cols + col] = depth >= EDGE ? damping : damping * (0.9 + 0.1 * depth / EDGE)
      }
    }
    pass = null
    helm = null
    aim = null
  }

  function course(index) {
    const narrow = width < 850
    const top = narrow ? height - 150 : height * 0.5
    const bottom = narrow ? height - 30 : height * 0.9
    const rising = index % 2 === 0
    const start = { x: narrow ? -30 : width * 0.44, y: rising ? bottom : top }
    const end = { x: width + 60, y: rising ? top + (bottom - top) * 0.2 : bottom - (bottom - top) * 0.15 }
    const length = Math.hypot(end.x - start.x, end.y - start.y)
    const sway = (bottom - top) * 0.08
    return {
      duration: length / BOAT_SPEED,
      at(progress) {
        return {
          x: start.x + (end.x - start.x) * progress,
          y: start.y + (end.y - start.y) * progress + Math.sin(progress * Math.PI * 2) * sway,
        }
      },
    }
  }

  // Lift the water under a point and lower it around, so that no water is
  // added overall and the surface comes back to rest at its own level.
  // `now` is height given at once, for a push that must show the instant it is made.
  function push(x, y, amount, now = 0) {
    const reach = BOW * 3
    const firstCol = Math.max(1, Math.floor((x - reach - originX) / DX))
    const lastCol = Math.min(cols - 2, Math.ceil((x + reach - originX) / DX))
    const firstRow = Math.max(1, Math.floor((y - reach - originY) / DY))
    const lastRow = Math.min(rows - 2, Math.ceil((y + reach - originY) / DY))
    for (let row = firstRow; row <= lastRow; row++) {
      const dy = originY + row * DY - y
      for (let col = firstCol; col <= lastCol; col++) {
        const dx = originX + col * DX - x
        const q = (dx * dx + dy * dy) / (2 * BOW * BOW)
        const shape = (1 - q) * Math.exp(-q)
        speed[row * cols + col] -= amount * shape
        if (now) level[row * cols + col] -= now * shape
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
        const point = pass.at(progress)
        // Ease in and out so the boat neither appears nor vanishes abruptly.
        push(point.x, point.y, PUSH * Math.min(1, progress * 8, (1 - progress) * 8))
      }
    } else if (!aim && clock >= nextPassAt) {
      pass = { ...course(passCount++), started: clock }
    }
    if (aim) {
      if (!helm) helm = { ...aim }
      const dx = aim.x - helm.x
      const dy = aim.y - helm.y
      const distance = Math.hypot(dx, dy)
      // The water answers under the pointer in the same step: the whole stretch
      // it just crossed is pushed at once, a dab every few pixels so that a fast
      // flick still draws one continuous line instead of scattered dots.
      if (distance > 0.5) {
        const dabs = Math.ceil(distance / POINTER_DAB)
        const share = distance / dabs
        for (let dab = 1; dab <= dabs; dab++) {
          push(helm.x + dx * dab / dabs, helm.y + dy * dab / dabs, POINTER_PUSH * share, POINTER_RISE * share)
        }
        helm.x = aim.x
        helm.y = aim.y
      }
    }
    for (let row = 1; row < rows - 1; row++) {
      const offset = row * cols
      for (let index = offset + 1; index < offset + cols - 1; index++) {
        const here = level[index]
        speed[index] = (speed[index]
          + kx * (level[index - 1] + level[index + 1] - 2 * here)
          + ky * (level[index - cols] + level[index + cols] - 2 * here)) * sponge[index]
      }
    }
    for (let index = 0; index < level.length; index++) level[index] += speed[index]
  }

  function draw() {
    context.clearRect(0, 0, width, height)
    const calm = new Path2D()
    const bright = LEVELS.map(() => new Path2D())
    let highest = 0
    for (let row = 1; row < rows - 1; row++) {
      const offset = row * cols
      const rowY = originY + row * DY + 0.5
      let previousX = originX
      let previousY = rowY
      let previousSize = 0
      for (let col = 0; col < cols; col++) {
        const lift = level[offset + col]
        const size = Math.hypot(lift, speed[offset + col] * SWING)
        const x = originX + col * DX
        // A soft ceiling: tall waves round off instead of flattening.
        const y = rowY + MAX_LIFT * Math.tanh(lift / MAX_LIFT)
        if (col > 0) {
          const strength = Math.max(size, previousSize)
          if (strength > highest) highest = strength
          let path = calm
          for (let index = LEVELS.length - 1; index >= 0; index--) {
            if (strength >= LEVELS[index]) { path = bright[index]; break }
          }
          path.moveTo(previousX, previousY)
          path.lineTo(x, y)
        }
        previousX = x
        previousY = y
        previousSize = size
      }
    }
    stirred = highest
    context.lineCap = 'round'
    context.lineWidth = 1
    context.strokeStyle = ink
    context.globalAlpha = 0.09
    context.stroke(calm)
    context.strokeStyle = wake
    bright.forEach((path, index) => {
      context.globalAlpha = ALPHAS[index]
      context.lineWidth = WIDTHS[index]
      context.stroke(path)
    })
    context.globalAlpha = 1
  }

  function tick(time) {
    frame = 0
    // A tab that was away comes back to a long gap: resume, do not replay it.
    pending += Math.min(0.05, Math.max(0, (time - lastTime) / 1000))
    lastTime = time
    const resting = !pass && !aim && stirred < LEVELS[0] * 0.5
    if (resting) {
      // Nothing moves: let time pass without recomputing or repainting the water.
      clock += pending
      pending = 0
      if (clock >= nextPassAt) pass = { ...course(passCount++), started: clock }
    } else {
      while (pending >= STEP) { step(); pending -= STEP }
    }
    if (!resting || pass) draw()
    schedule()
  }

  function schedule() {
    if (frame || !visible || document.hidden || reducedMotion.matches) return
    lastTime = performance.now()
    frame = requestAnimationFrame((time) => { lastTime = Math.min(lastTime, time); tick(time) })
  }

  // Without motion, show the wake as it stands when the boat is most of the way across.
  function drawStill() {
    level.fill(0)
    speed.fill(0)
    aim = null
    clock = 0
    pass = { ...course(0), started: 0 }
    const until = pass.duration * 0.8
    while (clock < until) step()
    pass = null
    draw()
  }

  function refresh() {
    readColors()
    if (reducedMotion.matches) drawStill()
    else draw()
    schedule()
  }

  hero.addEventListener('pointermove', (event) => {
    if (reducedMotion.matches || event.pointerType === 'touch') return
    const bounds = canvas.getBoundingClientRect()
    aim = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    // The visitor is steering; hold the next unattended pass back.
    pass = null
    schedule()
  }, { passive: true })

  hero.addEventListener('pointerleave', () => {
    aim = null
    helm = null
    nextPassAt = clock + CALM_BETWEEN_PASSES
  })

  new ResizeObserver(() => { resize(); refresh() }).observe(canvas)
  new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; schedule() }).observe(canvas)
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  document.addEventListener('visibilitychange', schedule)
  reducedMotion.addEventListener('change', () => {
    level.fill(0)
    speed.fill(0)
    pass = null
    clock = 0
    nextPassAt = 0.4
    refresh()
  })
  canvas.setAttribute('data-wake-ready', '')
})()
