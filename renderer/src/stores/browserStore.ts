import { useEffect } from 'react'
import { create } from 'zustand'
import type { BrowserState } from '@shared/types'
import { api } from '../lib/api'

const useStore = create<{ states: Record<string, BrowserState> }>(() => ({ states: {} }))
const watches = new Map<string, { count: number; dispose: () => void }>()
function watch(botId: string) {
  const existing = watches.get(botId)
  if (existing) { existing.count++; return () => unwatch(botId) }
  let active = true, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined
  const refresh = async () => {
    const version = ++sequence
    try { const state = await api.getBrowserState(botId); if (active && version === sequence) useStore.setState((previous) => ({ states: { ...previous.states, [botId]: state } })) }
    catch { /* A deleted Bot cannot receive browser state. */ }
  }
  void refresh()
  const off = api.onEvent((event) => { if (event.type === 'browser-updated' && event.botId === botId) { clearTimeout(timer); timer = setTimeout(() => void refresh(), 40) } })
  watches.set(botId, { count: 1, dispose: () => { active = false; clearTimeout(timer); off() } })
  return () => unwatch(botId)
}
function unwatch(botId: string) { const entry = watches.get(botId); if (entry && --entry.count === 0) { entry.dispose(); watches.delete(botId) } }
export function useBrowserState(botId: string) {
  const state = useStore((store) => store.states[botId])
  useEffect(() => watch(botId), [botId])
  return state
}
