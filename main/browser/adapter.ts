import type { BrowserBackend, BrowserInput } from '../../shared/types'
import type { Cdp } from './snapshot'

/** Transport boundary. A sandbox worker can implement this without exposing Electron or CDP to React/model code. */
export interface BrowserAdapter {
  readonly backend: BrowserBackend
  readonly label: string
  readonly cdp: Cdp
  url(): string
  title(): string
  load(url: string): Promise<void>
  stop(): void
  show(): Promise<void>
  capture(): Promise<{ width: number; height: number; dataUrl: string }>
  input(input: BrowserInput, width: number, height: number): Promise<void>
  resize(): void
  close(): void | Promise<void>
}
export interface AdapterDownload {
  pause(): void
  resume(): void
  cancel(): void
  setSavePath(file: string): void
  getFilename(): string
  getURL(): string
  getTotalBytes(): number
  getReceivedBytes(): number
  getState(): string
  on(event: 'updated', callback: () => void): unknown
  once(event: 'done', callback: (event: unknown, status: string) => void): unknown
}
export interface AdapterHost {
  botId: string
  location(): void
  navigation(): void
  allowNavigation(url: string): boolean
  humanInput(): boolean
  lost(): void
  download(item: AdapterDownload): void
}
