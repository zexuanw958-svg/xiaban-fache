import type { Ticket } from './types'

export function conductorCount(ticketCount: number, minCrew: number) {
  if (ticketCount <= minCrew) return ticketCount
  return Math.max(1, Math.min(3, Math.round(ticketCount / 3)))
}

export function pickConductors(tickets: Ticket[], minCrew: number, seed = Math.random()) {
  const count = conductorCount(tickets.length, minCrew)
  const pool = [...tickets]
  const result: string[] = []
  let cursor = Math.floor(seed * Math.max(pool.length, 1))
  while (result.length < count && pool.length) {
    const index = cursor % pool.length
    result.push(pool.splice(index, 1)[0].memberId)
    cursor = (cursor + 2) % Math.max(pool.length, 1)
  }
  return result
}

