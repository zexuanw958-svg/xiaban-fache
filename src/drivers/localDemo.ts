import type { TripEvent, TripState } from '../engine/types'
import { tripReducer } from '../engine/reducer'

export type LocalDispatch = (event: TripEvent) => void

/** Stage-safe helpers for the offline demo. The server can later replace this driver. */
export function demoDraw(state: TripState, dispatch: LocalDispatch) {
  // Keep the director's local demo legible: if the person at the controls voted,
  // put them first in the deterministic draw so the slide-to-depart interaction
  // is always available on stage. A real driver will use the server's result.
  const ids = state.tickets.map((ticket) => ticket.memberId)
  const ordered = ids.includes('me') ? ['me', ...ids.filter((id) => id !== 'me')] : ids
  const count = ordered.length <= state.minCrew ? ordered.length : Math.max(1, Math.min(3, Math.round(ordered.length / 3)))
  dispatch({ type: 'DRAW_RESULT', conductorIds: ordered.slice(0, count), drawStartAt: Date.now() })
}

export function demoSeedTickets(dispatch: LocalDispatch, ids: string[]) {
  ids.forEach((memberId) => dispatch({ type: 'SUBMIT_TICKET', memberId }))
}

export function applyDemoEvent(state: TripState, event: TripEvent) {
  return tripReducer(state, event)
}
