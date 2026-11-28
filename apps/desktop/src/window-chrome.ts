import { BrowserWindow, Menu, ipcMain, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import { WINDOW_CHANNELS } from './ipc'
import { isHexColor, isStartupColors, type WindowTheme, type WindowThemeStore } from './window-theme'

/** The interface's title bar (`--sg-window-bar`), until it reports its height at the current zoom. */
const BAR_HEIGHT = 36
/** macOS lights: their left margin, and the height of the buttons centred in the bar. */
const LIGHTS_X = 14
const LIGHTS_HEIGHT = 14

const lightsIn = (height: number) => ({ x: LIGHTS_X, y: Math.round((height - LIGHTS_HEIGHT) / 2) })

/** The colours the interface last reported (window-theme.ts), until it sends them again (`colors` below). */
export function windowChromeOptions(theme: WindowTheme): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    backgroundColor: theme.canvas,
    titleBarOverlay: { height: BAR_HEIGHT, color: theme.canvas, symbolColor: theme.inkSoft },
    ...(process.platform === 'darwin' ? { trafficLightPosition: lightsIn(BAR_HEIGHT) } : {}),
  }
}

export function setupWindowChrome(isAppUrl: (url: string) => boolean, themes: WindowThemeStore): void {
  const windowFor = (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    // Only the top-level application may control its own window.
    if (!win || event.senderFrame !== event.sender.mainFrame || !isAppUrl(event.senderFrame.url)) throw new Error('refused')
    return win
  }
  ipcMain.handle(WINDOW_CHANNELS.menu, (event, at: unknown) => {
    const win = windowFor(event)
    const { x, y } = (at ?? {}) as { x?: unknown; y?: unknown }
    const placed = typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)
    // Page pixels to window pixels: zoom scales the one, not the other.
    const zoom = event.sender.getZoomFactor()
    Menu.getApplicationMenu()?.popup({ window: win, ...(placed ? { x: Math.round(x * zoom), y: Math.round(y * zoom) } : {}) })
  })
  ipcMain.handle(WINDOW_CHANNELS.colors, (event, background: unknown, foreground: unknown, startup: unknown) => {
    const win = windowFor(event)
    if (!isHexColor(background) || !isHexColor(foreground)) throw new Error('invalid colors')
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: background, symbolColor: foreground })
    win.setBackgroundColor(background)
    if (isStartupColors(startup)) {
      const { ink, accent, dark, followsSystem } = startup
      themes.remember({ canvas: background, inkSoft: foreground, ink, accent, dark, followsSystem })
    }
  })
  ipcMain.handle(WINDOW_CHANNELS.layout, (event, height: unknown) => {
    const win = windowFor(event)
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 16 || height > 120) throw new Error('invalid height')
    // The page measures in CSS pixels; the controls in window pixels, which zoom scales.
    const bar = Math.round(height * event.sender.getZoomFactor())
    if (process.platform === 'darwin') win.setWindowButtonPosition(lightsIn(bar))
    else win.setTitleBarOverlay({ height: bar })
  })
}
