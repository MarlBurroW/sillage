import { BrowserWindow, Menu, ipcMain, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import { WINDOW_CHANNELS } from './ipc'

/** The interface's title bar (`--sg-window-bar`), until it reports its height at the current zoom. */
const BAR_HEIGHT = 36
/** macOS lights: their left margin, and the height of the buttons centred in the bar. */
const LIGHTS_X = 14
const LIGHTS_HEIGHT = 14

const lightsIn = (height: number) => ({ x: LIGHTS_X, y: Math.round((height - LIGHTS_HEIGHT) / 2) })

/** Startup page colours until the interface sends its own (`colors` below). */
export function windowChromeOptions(dark: boolean): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    titleBarOverlay: dark
      ? { height: BAR_HEIGHT, color: '#0b0d1c', symbolColor: '#e1e3ef' }
      : { height: BAR_HEIGHT, color: '#f7f7fb', symbolColor: '#2a2d42' },
    ...(process.platform === 'darwin' ? { trafficLightPosition: lightsIn(BAR_HEIGHT) } : {}),
  }
}

export function setupWindowChrome(isAppUrl: (url: string) => boolean): void {
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
  ipcMain.handle(WINDOW_CHANNELS.colors, (event, background: unknown, foreground: unknown) => {
    const win = windowFor(event)
    const hex = /^#[0-9a-f]{6}$/i
    if (typeof background !== 'string' || typeof foreground !== 'string' || !hex.test(background) || !hex.test(foreground)) throw new Error('invalid colors')
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: background, symbolColor: foreground })
    win.setBackgroundColor(background)
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
