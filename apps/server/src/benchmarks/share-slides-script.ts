/**
 * Behaviour of the slideshow. A constant, so its hash can be pinned in the policy of every copy:
 * everything that varies per benchmark lives in the markup (data- attributes, `sg-reveal`
 * wrappers) or in the `slides-data` JSON block, and the script builds DOM with `textContent` only.
 *
 * The position is one counter over every step of every slide. Visibility is derived from it
 * rather than toggled by events, so going back hides a name again and a retake replays the
 * reveal exactly. Only the current slide's productions are loaded: a hidden page would keep
 * playing its sound during the next take.
 *
 * Written as `String.raw` so the source reads as plain JavaScript; it must not contain a backtick
 * or a dollar sign followed by a brace.
 */
export const SLIDES_SCRIPT = String.raw`(function () {
  'use strict'
  var d = document
  var root = d.documentElement
  root.classList.add('js')
  var stage = d.querySelector('[data-stage]')
  var slides = Array.prototype.slice.call(d.querySelectorAll('[data-slide]'))
  if (!stage || !slides.length) return
  var data = {}
  try { data = JSON.parse((d.getElementById('slides-data') || {}).textContent || '{}') } catch (error) { data = {} }
  var info = data.slides || []
  var counts = slides.map(function (slide) { return Math.max(1, Number(slide.getAttribute('data-steps')) || 1) })
  var bases = []
  var total = 0
  counts.forEach(function (count) { bases.push(total); total += count })
  var closer = d.querySelector('[data-exit][data-close]')
  if (closer) closer.addEventListener('click', function (event) {
    // Only the window the app's Present action opened (it names it) closes; a preview tab that
    // navigated here goes back to its page through the link.
    if (window.opener && /^sillage-slides-/.test(window.name)) { event.preventDefault(); window.close() }
  })
  var params = new URLSearchParams(location.search)
  var pinned = /^(\d{3,5})x(\d{3,5})$/.exec(params.get('size') || '')
  var state = { slide: 0, step: 0, clean: params.get('clean') === '1', auto: params.get('autoplay') === '1', band: true, black: false }
  var hud = d.querySelector('[data-hud]')
  var counter = d.querySelector('[data-counter]')
  var overview = d.querySelector('[data-overview]')
  var help = d.querySelector('[data-help]')
  var black = d.querySelector('[data-black]')
  var hint = d.querySelector('[data-focus-hint]')
  var timer = 0
  var hudTimer = 0
  var idleTimer = 0
  var entered = -1
  var lock = null
  var typed = ''

  function position() { return bases[state.slide] + state.step }
  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }

  // The stage is laid out once at 1920x1080 and scaled; ?size= pins it for pixel-exact capture.
  function fit() {
    var scale
    if (pinned) {
      root.classList.add('pinned')
      scale = Number(pinned[1]) / 1920
    } else {
      scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080)
    }
    stage.style.setProperty('--scale', String(scale))
  }

  function reveal() {
    var at = position()
    var list = d.querySelectorAll('sg-reveal')
    for (var i = 0; i < list.length; i++) list[i].hidden = at < Number(list[i].getAttribute('data-at'))
    list = d.querySelectorAll('sg-conceal')
    for (i = 0; i < list.length; i++) list[i].hidden = at >= Number(list[i].getAttribute('data-at'))
  }

  // A fresh slide starts with nothing shown and gets its steps a frame later, so bars and rows
  // animate in instead of appearing already drawn.
  function steps(slide, fresh) {
    var items = Array.prototype.slice.call(slide.querySelectorAll('[data-step],[data-until]'))
    if (fresh) {
      items.forEach(function (item) { item.classList.remove('on') })
      void slide.offsetWidth
    }
    items.forEach(function (item) {
      var from = Number(item.getAttribute('data-step') || 0)
      var until = item.getAttribute('data-until')
      item.classList.toggle('on', state.step >= from && (until === null || state.step < Number(until)))
    })
  }

  function load(frame) {
    frame.classList.remove('loaded')
    frame.onload = function () { if (frame.getAttribute('data-live') === '1') frame.classList.add('loaded') }
    frame.setAttribute('data-live', '1')
    frame.setAttribute('src', frame.getAttribute('data-src'))
  }
  function unload(frame) {
    frame.onload = null
    frame.removeAttribute('data-live')
    frame.classList.remove('loaded')
    frame.setAttribute('src', 'about:blank')
  }
  function frames() {
    slides.forEach(function (slide, index) {
      var list = slide.querySelectorAll('iframe[data-src]')
      for (var i = 0; i < list.length; i++) {
        var live = list[i].getAttribute('data-live') === '1'
        if (index === state.slide && !live) load(list[i])
        else if (index !== state.slide && live) unload(list[i])
      }
      if (index !== state.slide) {
        var media = slide.querySelectorAll('video,audio')
        for (var j = 0; j < media.length; j++) media[j].pause()
      }
    })
  }

  function writeHash() {
    var hash = '#/' + (state.slide + 1) + '/' + (state.step + 1)
    if (location.hash !== hash) history.replaceState(null, '', hash)
  }
  function readHash() {
    var match = /^#\/(\d+)(?:\/(\d+))?$/.exec(location.hash)
    if (!match) return false
    state.slide = clamp(Number(match[1]) - 1, 0, slides.length - 1)
    state.step = clamp(Number(match[2] || 1) - 1, 0, counts[state.slide] - 1)
    return true
  }

  function render() {
    var slide = slides[state.slide]
    var fresh = entered !== state.slide
    if (fresh) {
      slides.forEach(function (item, index) { item.classList.toggle('current', index === state.slide) })
      entered = state.slide
      frames()
    }
    reveal()
    steps(slide, fresh)
    if (counter) counter.textContent = (state.slide + 1) + ' / ' + slides.length
    writeHash()
    schedule()
    if (overview && !overview.hidden) buildOverview()
  }

  function go(slide, step) {
    state.slide = clamp(slide, 0, slides.length - 1)
    state.step = clamp(step, 0, counts[state.slide] - 1)
    render()
  }
  function next() {
    if (state.step < counts[state.slide] - 1) go(state.slide, state.step + 1)
    else if (state.slide < slides.length - 1) go(state.slide + 1, 0)
    else setAuto(false)
  }
  function previous() {
    if (state.step > 0) go(state.slide, state.step - 1)
    else if (state.slide > 0) go(state.slide - 1, counts[state.slide - 1] - 1)
  }

  // Autoplay dwells per step, from the slide's comma-separated seconds; the last value repeats.
  function dwell() {
    var list = (slides[state.slide].getAttribute('data-dwell') || '6').split(',')
    return (Number(list[Math.min(state.step, list.length - 1)]) || 6) * 1000
  }
  function schedule() {
    clearTimeout(timer)
    if (state.auto && position() < total - 1) timer = setTimeout(next, dwell())
  }
  function setAuto(on) {
    state.auto = on
    root.classList.toggle('auto', on)
    press('autoplay', on)
    if (on && navigator.wakeLock && window.isSecureContext) {
      navigator.wakeLock.request('screen').then(function (sentinel) { lock = sentinel }).catch(function () {})
    } else if (!on && lock) {
      lock.release().catch(function () {})
      lock = null
    }
    schedule()
  }
  function setClean(on) {
    state.clean = on
    root.classList.toggle('clean', on)
    if (on && hud) hud.classList.remove('on')
    if (on && hint) hint.hidden = true
    press('clean', on)
  }
  function setBand(on) {
    state.band = on
    root.classList.toggle('no-band', !on)
    press('band', on)
  }
  function setBlack(on) {
    state.black = on
    if (black) black.hidden = !on
  }
  function press(action, on) {
    var button = d.querySelector('[data-act="' + action + '"]')
    if (button) button.setAttribute('aria-pressed', String(on))
  }

  function fullscreen() {
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      var leave = d.exitFullscreen || d.webkitExitFullscreen
      if (leave) leave.call(d)
      return
    }
    var enter = root.requestFullscreen || root.webkitRequestFullscreen
    if (!enter) return
    var result = enter.call(root)
    if (result && result.catch) result.catch(function () {})
  }

  function current(selector) { return Array.prototype.slice.call(slides[state.slide].querySelectorAll(selector)) }
  function reload() {
    current('iframe[data-src]').forEach(function (frame) { load(frame) })
  }
  function zoom(delta) {
    current('[data-frame]').forEach(function (frame) {
      var value = Number(getComputedStyle(frame).getPropertyValue('--zoom')) || 1
      frame.style.setProperty('--zoom', String(clamp(Math.round((value + delta) * 10) / 10, 0.5, 2.5)))
    })
  }
  function scroll(direction) {
    current('[data-scroll]').forEach(function (panel) {
      if (panel.offsetParent !== null) panel.scrollBy({ top: direction * 160, behavior: 'smooth' })
    })
  }

  function buildOverview() {
    var grid = overview.querySelector('[data-grid]')
    grid.textContent = ''
    var at = position()
    info.forEach(function (entry, index) {
      var button = d.createElement('button')
      button.type = 'button'
      button.className = 'ov-item'
      var number = d.createElement('span')
      number.className = 'ov-n'
      number.textContent = String(index + 1)
      var title = d.createElement('span')
      // Names stay hidden in the list until the position reveals them, like on the slides.
      title.textContent = typeof entry.at === 'number' && at < entry.at ? entry.blind : entry.title
      button.appendChild(number)
      button.appendChild(title)
      if (index === state.slide) button.setAttribute('aria-current', 'true')
      button.addEventListener('click', function () { closeOverlays(); go(index, 0) })
      grid.appendChild(button)
    })
  }
  function openOverview() {
    closeOverlays()
    buildOverview()
    overview.hidden = false
    var mine = overview.querySelector('[aria-current="true"]')
    if (mine) mine.focus({ preventScroll: false })
  }
  function openHelp() {
    closeOverlays()
    help.hidden = false
  }
  function closeOverlays() {
    if (overview) overview.hidden = true
    if (help) help.hidden = true
    typed = ''
    stage.focus({ preventScroll: true })
  }

  function overviewKey(event) {
    var items = Array.prototype.slice.call(overview.querySelectorAll('.ov-item'))
    var at = items.indexOf(d.activeElement)
    if (/^[0-9]$/.test(event.key)) { typed += event.key; return true }
    if (event.key === 'Enter' && typed) { var target = Number(typed) - 1; closeOverlays(); go(target, 0); return true }
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { (items[Math.min(items.length - 1, at + 1)] || items[0]).focus(); return true }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { (items[Math.max(0, at - 1)] || items[0]).focus(); return true }
    return false
  }

  d.addEventListener('keydown', function (event) {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
    var key = event.key
    var open = (overview && !overview.hidden) || (help && !help.hidden)
    if (open) {
      if (key === 'Escape' || ((key === 'g' || key === 'G') && !overview.hidden) || (key === '?' && !help.hidden)) closeOverlays()
      else if (overview.hidden || !overviewKey(event)) return
      event.preventDefault()
      return
    }
    // A focused control, or a video or sound of a gallery, keeps Enter and Space for itself.
    var control = event.target && event.target.closest && event.target.closest('button,a,video,audio')
    if (control && (key === 'Enter' || key === ' ')) return
    switch (key) {
      case 'ArrowRight': case 'PageDown': if (event.shiftKey) go(state.slide + 1, 0); else next(); break
      case ' ': if (event.shiftKey) previous(); else next(); break
      case 'Enter': next(); break
      case 'ArrowLeft': case 'PageUp': case 'Backspace': if (event.shiftKey) go(state.slide - 1, 0); else previous(); break
      case 'Home': go(0, 0); break
      case 'End': go(slides.length - 1, 0); break
      case 'ArrowDown': scroll(1); break
      case 'ArrowUp': scroll(-1); break
      case 'g': case 'G': openOverview(); break
      case 'f': case 'F': case 'F5': fullscreen(); break
      case 'c': case 'C': setClean(!state.clean); break
      case 'b': case 'B': case '.': setBlack(!state.black); break
      case 'h': case 'H': setBand(!state.band); break
      case 'r': case 'R': reload(); break
      case 'a': case 'A': setAuto(!state.auto); break
      case '+': case '=': zoom(0.1); break
      case '-': case '_': zoom(-0.1); break
      case '?': openHelp(); break
      case 'Escape': if (state.black) { setBlack(false); break } return
      default: return
    }
    event.preventDefault()
  })

  var actions = {
    previous: previous,
    next: next,
    overview: openOverview,
    band: function () { setBand(!state.band) },
    autoplay: function () { setAuto(!state.auto) },
    clean: function () { setClean(!state.clean) },
    fullscreen: fullscreen,
    help: openHelp,
    close: closeOverlays
  }
  Array.prototype.forEach.call(d.querySelectorAll('[data-act]'), function (button) {
    button.addEventListener('click', function () {
      var action = actions[button.getAttribute('data-act')]
      if (action) action()
    })
  })

  // Controls appear while the pointer moves and fade two seconds later; in clean mode they stay
  // away and the cursor disappears after a second, so neither ends up in the recording.
  d.addEventListener('pointermove', function () {
    root.classList.remove('idle')
    clearTimeout(idleTimer)
    idleTimer = setTimeout(function () { root.classList.add('idle') }, 1000)
    if (state.clean || !hud) return
    hud.classList.add('on')
    clearTimeout(hudTimer)
    hudTimer = setTimeout(function () {
      if (!hud.matches(':hover') && !hud.contains(d.activeElement)) hud.classList.remove('on')
    }, 2000)
  })

  // Keys typed while a production has focus go to the production: take the keyboard back as soon
  // as the pointer leaves it, and say why the slides stopped answering meanwhile.
  function holds() { return !!d.activeElement && /^(IFRAME|VIDEO|AUDIO)$/.test(d.activeElement.tagName) }
  function reclaim() {
    if (holds()) stage.focus({ preventScroll: true })
    if (hint) hint.hidden = true
  }
  Array.prototype.forEach.call(d.querySelectorAll('[data-frame]'), function (frame) {
    frame.addEventListener('pointerleave', reclaim)
  })
  window.addEventListener('blur', function () {
    setTimeout(function () {
      if (hint && !state.clean && d.activeElement && d.activeElement.tagName === 'IFRAME') hint.hidden = false
    }, 0)
  })
  window.addEventListener('focus', function () { if (hint) hint.hidden = true })

  window.addEventListener('hashchange', function () { if (readHash()) render() })
  window.addEventListener('resize', fit)
  fit()
  readHash()
  setClean(state.clean)
  setBand(true)
  setAuto(state.auto)
  render()
  stage.focus({ preventScroll: true })
})()`
