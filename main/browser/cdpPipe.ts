import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/** Chrome --remote-debugging-pipe: private inherited FDs, no listening TCP/debugging port. */
export class CdpPipe {
  private nextId = 0
  private buffer = Buffer.alloc(0)
  private closed = false
  private pending = new Map<number, { resolve(value: any): void; reject(reason: Error): void; timer: ReturnType<typeof setTimeout> }>()
  private listeners = new Set<(method: string, parameters: any, sessionId?: string) => void>()
  constructor(private process: ChildProcess) {
    ;(process.stdio[4] as Readable).on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data])
      if (this.buffer.length > 24 * 1024 * 1024) { this.close(); return }
      let end: number
      while ((end = this.buffer.indexOf(0)) !== -1) {
        const line = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 1)
        if (!line) continue
        let message: any
        try { message = JSON.parse(line) } catch { this.close(); return }
        if (message.id) {
          const pending = this.pending.get(message.id)
          if (!pending) continue
          this.pending.delete(message.id); clearTimeout(pending.timer)
          if (message.error) pending.reject(new Error(`浏览器协议调用失败：${message.error.message}`)); else pending.resolve(message.result ?? {})
        } else for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId)
      }
    })
    process.once('exit', () => this.close()); process.once('error', () => this.close())
    ;(process.stdio[3] as Writable).on('error', () => this.close())
  }
  on(listener: (method: string, parameters: any, sessionId?: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.closed) return Promise.reject(new Error('本地浏览器连接已关闭'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('浏览器协议调用超时')) }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
      ;(this.process.stdio[3] as Writable).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
    })
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('本地浏览器连接已关闭')) }
    this.pending.clear(); this.listeners.clear(); this.buffer = Buffer.alloc(0)
  }
}
