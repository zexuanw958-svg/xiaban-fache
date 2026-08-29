import type { TripEvent, TripState } from '../engine/types'

export type JoinMessage = { type: 'JOIN'; teamCode: string; memberId: string; name: string; emoji: string }
export type ServerMessage =
  | { type: 'HELLO'; protocol: string }
  | { type: 'WELCOME'; teamCode: string; teamName: string; memberId: string; state: TripState }
  | { type: 'STATE'; teamCode: string; teamName: string; clients: number; state: TripState }
  | { type: 'DRAW_RESULT'; conductors: string[]; drawStartAt: number }
  | { type: 'ERROR'; code: string; phase?: string }

export type ServerEvent = Extract<TripEvent, { type: 'SUBMIT_TICKET' | 'WITHDRAW_TICKET' | 'DECLINE_DUTY' | 'ACCEPT_DUTY' | 'DEPART' | 'BOARD' | 'SETTLE' }>

export interface TripDriver {
  connect(): void
  disconnect(): void
  send(event: ServerEvent): void
  subscribe(listener: (state: TripState) => void): () => void
}

/**
 * WebSocket adapter for S1. The UI can swap this for LocalDemo without knowing
 * whether events are travelling over a socket. Re-JOIN on reconnect is
 * intentional: the server responds with a fresh full snapshot.
 */
export function createWsDriver(url: string, join: JoinMessage): TripDriver {
  let socket: WebSocket | undefined
  let listener: ((state: TripState) => void) | undefined
  let retryTimer: number | undefined
  let disposed = false

  const open = () => {
    if (disposed || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return
    socket = new WebSocket(url)
    socket.addEventListener('open', () => socket?.send(JSON.stringify(join)))
    socket.addEventListener('message', (message) => {
      const data = JSON.parse(String(message.data)) as ServerMessage
      if (data.type === 'STATE' || data.type === 'WELCOME') listener?.(data.state)
    })
    socket.addEventListener('close', () => {
      if (!disposed) retryTimer = window.setTimeout(open, 1200)
    })
  }
  const onVisibility = () => { if (document.visibilityState === 'visible') open() }
  document.addEventListener('visibilitychange', onVisibility)

  return {
    connect() { disposed = false; open() },
    disconnect() {
      disposed = true
      if (retryTimer) window.clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      socket?.close()
    },
    send(event) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
    },
    subscribe(next) { listener = next; return () => { listener = undefined } },
  }
}
