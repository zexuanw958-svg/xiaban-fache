import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import { createInitialState, tripReducer } from '../src/engine/reducer'
import { pickConductors } from '../src/engine/rules'
import type { Member, TripEvent, TripState } from '../src/engine/types'

const PORT = Number(process.env.PORT ?? 8787)
const DEFAULT_DEPART_IN_SECONDS = Number(process.env.DEPART_IN_SECONDS ?? 1800)
const DRAW_ANIMATION_SECONDS = Number(process.env.DRAW_ANIMATION_SECONDS ?? 20)
const rooms = new Map<string, Room>()

type Client = { socket: WebSocket; memberId?: string; roomCode?: string }
type Room = {
  code: string
  teamName: string
  state: TripState
  clients: Set<Client>
  tickTimer: NodeJS.Timeout
  drawTimer?: NodeJS.Timeout
  dutyTimers: Map<string, NodeJS.Timeout>
  settleTimer?: NodeJS.Timeout
  expireTimer?: NodeJS.Timeout
  createdAt: number
}

type JoinMessage = { type: 'JOIN'; teamCode: string; memberId: string; name: string; emoji: string }
type ClientMessage = JoinMessage | { type: 'SUBMIT_TICKET' | 'WITHDRAW_TICKET' | 'DECLINE_DUTY' | 'ACCEPT_DUTY' | 'DEPART' | 'BOARD' | 'SETTLE'; memberId?: string }

function nextDepartAt(inSeconds = DEFAULT_DEPART_IN_SECONDS) {
  return Date.now() + Math.max(5, inSeconds) * 1000
}

function cleanCode(value: unknown) {
  const code = String(value ?? '').trim().toUpperCase()
  return /^[A-Z][A-Z0-9]{2,11}$/.test(code) ? code : undefined
}

function cleanText(value: unknown, fallback: string, max = 16) {
  const text = String(value ?? '').trim().replace(/[<>]/g, '')
  return text.slice(0, max) || fallback
}

function makeRoom(code: string, options: { teamName?: string; departInSeconds?: number; minCrew?: number } = {}) {
  const base = createInitialState()
  const state: TripState = {
    ...base,
    phase: 'idle',
    departAt: nextDepartAt(options.departInSeconds),
    members: [],
    tickets: [],
    conductors: [],
    declined: [],
    boarded: [],
    acceptedDuties: [],
    minCrew: Math.max(2, Math.min(12, Number(options.minCrew ?? 3))),
    notification: undefined,
  }
  const room: Room = {
    code,
    teamName: cleanText(options.teamName, `${code} 次晚高峰`, 32),
    state,
    clients: new Set(),
    tickTimer: setInterval(() => tickRoom(room), 1000),
    dutyTimers: new Map(),
    createdAt: Date.now(),
  }
  rooms.set(code, room)
  return room
}

function getOrCreateRoom(code: string) {
  return rooms.get(code) ?? makeRoom(code)
}

function snapshot(room: Room) {
  return { teamCode: room.code, teamName: room.teamName, clients: room.clients.size, state: room.state }
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
}

function broadcast(room: Room, payload: unknown) {
  for (const client of room.clients) send(client.socket, payload)
}

function broadcastState(room: Room) {
  broadcast(room, { type: 'STATE', ...snapshot(room) })
}

function apply(room: Room, event: TripEvent) {
  const next = tripReducer(room.state, event)
  if (next === room.state) return false
  room.state = next
  broadcastState(room)
  return true
}

function scheduleDutyTimeout(room: Room, memberId: string) {
  const previous = room.dutyTimers.get(memberId)
  if (previous) clearTimeout(previous)
  const timer = setTimeout(() => {
    room.dutyTimers.delete(memberId)
    if (room.state.phase === 'departing' && room.state.conductors.includes(memberId) && !room.state.acceptedDuties.includes(memberId)) {
      const before = room.state.conductors.slice()
      apply(room, { type: 'DECLINE_DUTY', memberId })
      const replacement = room.state.conductors.find((id) => !before.includes(id))
      if (replacement) scheduleDutyTimeout(room, replacement)
    }
  }, 10000)
  room.dutyTimers.set(memberId, timer)
}

function enterDeparting(room: Room) {
  if (!apply(room, { type: 'DIRECTOR_SET_PHASE', phase: 'departing' })) return
  for (const conductorId of room.state.conductors) scheduleDutyTimeout(room, conductorId)
}

function scheduleSettlement(room: Room) {
  if (room.settleTimer) clearTimeout(room.settleTimer)
  room.settleTimer = setTimeout(() => {
    room.settleTimer = undefined
    if (room.state.phase === 'departed') apply(room, { type: 'SETTLE' })
  }, 30 * 60 * 1000)
}

function startDraw(room: Room) {
  if (room.state.phase !== 'boarding') return
  const ticketCount = room.state.tickets.length
  if (ticketCount < room.state.minCrew) {
    apply(room, { type: 'SUSPEND' })
    return
  }
  const conductorIds = pickConductors(room.state.tickets, room.state.minCrew)
  const drawStartAt = Date.now() + 2000
  apply(room, { type: 'DRAW_RESULT', conductorIds, drawStartAt })
  // Small crews do not need a ceremony wall: all ticket holders are conductors
  // and the room moves straight into the duty card phase.
  if (ticketCount <= room.state.minCrew) {
    enterDeparting(room)
    return
  }
  broadcast(room, { type: 'DRAW_RESULT', conductors: conductorIds, drawStartAt })
  // drawStartAt is T+2s, then the UI performs a 20s deterministic animation.
  const duration = (Math.max(1, DRAW_ANIMATION_SECONDS) + 2) * 1000
  room.drawTimer = setTimeout(() => {
    room.drawTimer = undefined
    enterDeparting(room)
  }, duration)
}

function tickRoom(room: Room) {
  const now = Date.now()
  if (room.state.phase === 'idle' && now >= room.state.departAt - 30 * 60 * 1000) {
    apply(room, { type: 'TICK', now })
  }
  if (room.state.phase === 'boarding' && now >= room.state.departAt) {
    startDraw(room)
  }
}

function addMember(room: Room, message: JoinMessage, client: Client) {
  const member: Member = {
    id: cleanText(message.memberId, randomUUID(), 64),
    name: cleanText(message.name, '未命名同事', 16),
    emoji: cleanText(message.emoji, '🧑‍💻', 8),
    role: '刚刚入队',
  }
  client.memberId = member.id
  client.roomCode = room.code
  for (const existing of room.clients) {
    if (existing !== client && existing.memberId === member.id) {
      existing.socket.close(4001, 'replaced by reconnect')
      room.clients.delete(existing)
    }
  }
  room.clients.add(client)
  if (room.expireTimer) {
    clearTimeout(room.expireTimer)
    room.expireTimer = undefined
  }
  apply(room, { type: 'ADD_MEMBER', member })
  send(client.socket, { type: 'WELCOME', ...snapshot(room), memberId: member.id })
  broadcastState(room)
}

function scheduleRoomExpiry(room: Room) {
  if (room.expireTimer || room.clients.size > 0) return
  room.expireTimer = setTimeout(() => {
    room.expireTimer = undefined
    if (room.clients.size > 0) return
    clearInterval(room.tickTimer)
    if (room.drawTimer) clearTimeout(room.drawTimer)
    if (room.settleTimer) clearTimeout(room.settleTimer)
    for (const timer of room.dutyTimers.values()) clearTimeout(timer)
    rooms.delete(room.code)
  }, 24 * 60 * 60 * 1000)
}

function eventForClient(message: ClientMessage, memberId: string): TripEvent | undefined {
  switch (message.type) {
    case 'SUBMIT_TICKET': return { type: 'SUBMIT_TICKET', memberId }
    case 'WITHDRAW_TICKET': return { type: 'WITHDRAW_TICKET', memberId }
    case 'DECLINE_DUTY': return { type: 'DECLINE_DUTY', memberId }
    case 'ACCEPT_DUTY': return { type: 'ACCEPT_DUTY', memberId }
    case 'DEPART': return { type: 'DEPART', memberId }
    case 'BOARD': return { type: 'BOARD', memberId }
    case 'SETTLE': return { type: 'SETTLE' }
    default: return undefined
  }
}

function canDispatch(room: Room, event: TripEvent, memberId: string) {
  if (event.type === 'DEPART' && !room.state.conductors.includes(memberId)) return false
  if (event.type === 'DEPART' && !room.state.acceptedDuties.includes(memberId)) return false
  if (event.type === 'DECLINE_DUTY' && !room.state.conductors.includes(memberId)) return false
  if (event.type === 'ACCEPT_DUTY' && !room.state.conductors.includes(memberId)) return false
  if (event.type === 'SUBMIT_TICKET' && !['boarding', 'drawing', 'departing'].includes(room.state.phase)) return false
  if (event.type === 'WITHDRAW_TICKET' && room.state.phase !== 'boarding') return false
  if (event.type === 'DEPART' && room.state.phase !== 'departing') return false
  if (event.type === 'ACCEPT_DUTY' && room.state.phase !== 'departing') return false
  if (event.type === 'BOARD' && room.state.phase !== 'departed') return false
  if (event.type === 'SETTLE' && room.state.phase !== 'departed') return false
  return true
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk))
    if (Buffer.concat(chunks).length > 1024 * 1024) throw new Error('payload too large')
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
}

function json(response: ServerResponse, status: number, payload: unknown) {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'content-type')
  response.end(JSON.stringify(payload))
}

const httpServer = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (request.method === 'OPTIONS') return json(response, 204, {})
    if (request.method === 'GET' && url.pathname === '/health') {
      return json(response, 200, { ok: true, service: 'xiaban-fache', rooms: rooms.size, now: Date.now() })
    }
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await readJson(request)
      let code = cleanCode(body.teamCode)
      if (!code || rooms.has(code)) {
        do { code = `G${Math.floor(100 + Math.random() * 900)}` } while (rooms.has(code))
      }
      const room = makeRoom(code, { teamName: cleanText(body.teamName, `${code} 次晚高峰`, 32), departInSeconds: Number(body.departInSeconds ?? DEFAULT_DEPART_IN_SECONDS), minCrew: Number(body.minCrew ?? 3) })
      return json(response, 201, { ...snapshot(room), invitePath: `/?room=${room.code}` })
    }
    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/)
    if (request.method === 'GET' && roomMatch) {
      const room = rooms.get(roomMatch[1].toUpperCase())
      return room ? json(response, 200, snapshot(room)) : json(response, 404, { error: 'room_not_found' })
    }
    return json(response, 404, { error: 'not_found' })
  } catch (error) {
    return json(response, 400, { error: error instanceof Error ? error.message : 'bad_request' })
  }
})

const wss = new WebSocketServer({ server: httpServer })
wss.on('connection', (socket) => {
  const client: Client = { socket }
  send(socket, { type: 'HELLO', protocol: 'fache.v1' })
  socket.on('message', (raw) => {
    try {
      const message = JSON.parse(String(raw)) as ClientMessage
      if (message.type === 'JOIN') {
        const code = cleanCode(message.teamCode)
        if (!code) return send(socket, { type: 'ERROR', code: 'INVALID_ROOM_CODE' })
        addMember(getOrCreateRoom(code), message, client)
        return
      }
      if (!client.roomCode || !client.memberId) return send(socket, { type: 'ERROR', code: 'JOIN_REQUIRED' })
      const room = rooms.get(client.roomCode)
      let event = room && eventForClient(message, client.memberId)
      if (!room || !event) return send(socket, { type: 'ERROR', code: 'UNSUPPORTED_EVENT' })
      if (event.type === 'SUBMIT_TICKET' && room.state.phase !== 'boarding') event = { ...event, late: true }
      if (!canDispatch(room, event, client.memberId)) return send(socket, { type: 'ERROR', code: 'EVENT_NOT_ALLOWED', phase: room.state.phase })
      if (event.type === 'ACCEPT_DUTY') {
        const timer = room.dutyTimers.get(client.memberId)
        if (timer) clearTimeout(timer)
        room.dutyTimers.delete(client.memberId)
      }
      if (event.type === 'DECLINE_DUTY') {
        const timer = room.dutyTimers.get(client.memberId)
        if (timer) clearTimeout(timer)
        room.dutyTimers.delete(client.memberId)
      }
      const changed = apply(room, event)
      if (changed && event.type === 'DEPART') scheduleSettlement(room)
      if (changed && event.type === 'DECLINE_DUTY') {
        const replacement = room.state.conductors.find((id) => !room.state.acceptedDuties.includes(id) && !room.dutyTimers.has(id))
        if (replacement) scheduleDutyTimeout(room, replacement)
      }
    } catch {
      send(socket, { type: 'ERROR', code: 'INVALID_JSON' })
    }
  })
  socket.on('close', () => {
    if (client.roomCode) {
      const room = rooms.get(client.roomCode)
      room?.clients.delete(client)
      if (room) scheduleRoomExpiry(room)
    }
  })
})

httpServer.listen(PORT, () => {
  console.log(`[fache] backend listening on http://localhost:${PORT}`)
  console.log(`[fache] websocket listening on ws://localhost:${PORT}`)
  console.log(`[fache] default depart timer: ${DEFAULT_DEPART_IN_SECONDS}s`)
  console.log(`[fache] draw animation window: ${DRAW_ANIMATION_SECONDS}s`)
})

function shutdown() {
  for (const room of rooms.values()) {
    clearInterval(room.tickTimer)
    if (room.drawTimer) clearTimeout(room.drawTimer)
    if (room.settleTimer) clearTimeout(room.settleTimer)
    if (room.expireTimer) clearTimeout(room.expireTimer)
    for (const timer of room.dutyTimers.values()) clearTimeout(timer)
  }
  httpServer.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
