import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge, DesktopUpdateState } from '@sillage/protocol'
import { DIAGNOSTIC_CHANNELS, UPDATE_CHANNELS, WINDOW_CHANNELS } from './ipc'

/**
 * Expose update actions without giving the sandboxed renderer access to Node or IPC.
 */
const bridge: DesktopBridge = {
  window: {
    platform: process.platform as 'darwin' | 'win32' | 'linux',
    menu: () => ipcRenderer.invoke(WINDOW_CHANNELS.menu) as Promise<void>,
    colors: (background, foreground) => ipcRenderer.invoke(WINDOW_CHANNELS.colors, background, foreground) as Promise<void>,
  },
  diagnostics: {
    export: () => ipcRenderer.invoke(DIAGNOSTIC_CHANNELS.export) as Promise<void>,
    record: (stage, metrics) => ipcRenderer.send(DIAGNOSTIC_CHANNELS.record, stage, metrics),
  },
  updates: {
    state: () => ipcRenderer.invoke(UPDATE_CHANNELS.state) as Promise<DesktopUpdateState>,
    subscribe(listener) {
      const forward = (_event: IpcRendererEvent, state: DesktopUpdateState) => listener(state)
      ipcRenderer.on(UPDATE_CHANNELS.changed, forward)
      return () => {
        ipcRenderer.removeListener(UPDATE_CHANNELS.changed, forward)
      }
    },
    check: () => ipcRenderer.invoke(UPDATE_CHANNELS.check) as Promise<void>,
    install: () => ipcRenderer.invoke(UPDATE_CHANNELS.install) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('sillageDesktop', bridge)
