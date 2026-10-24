import { BrowserWindow, Menu, ipcMain, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import { WINDOW_CHANNELS } from './ipc'

export function windowChromeOptions(): BrowserWindowConstructorOptions {
  return {
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    titleBarOverlay: { height: 36, color: '#0b0d1c', symbolColor: '#e1e3ef' },
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 11 } } : {}),
  }
}

export function setupWindowChrome(isAppUrl: (url: string) => boolean): void {
  const windowFor = (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    // Only the top-level application may control its own window.
    if (!win || event.senderFrame !== event.sender.mainFrame || !isAppUrl(event.senderFrame.url)) throw new Error('refused')
    return win
  }
  ipcMain.handle(WINDOW_CHANNELS.menu, (event) => {
    const win = windowFor(event)
    Menu.getApplicationMenu()?.popup({ window: win })
  })
  ipcMain.handle(WINDOW_CHANNELS.colors, (event, background: unknown, foreground: unknown) => {
    const win = windowFor(event)
    const hex = /^#[0-9a-f]{6}$/i
    if (typeof background !== 'string' || typeof foreground !== 'string' || !hex.test(background) || !hex.test(foreground)) throw new Error('invalid colors')
    if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: background, symbolColor: foreground })
    win.setBackgroundColor(background)
  })
}
