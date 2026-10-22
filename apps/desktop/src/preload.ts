import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DesktopBridge, DesktopUpdateState } from '@sillage/protocol'
import { UPDATE_CHANNELS } from './ipc'

/**
 * Expose update actions without giving the sandboxed renderer access to Node or IPC.
 */
const bridge: DesktopBridge = {
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
