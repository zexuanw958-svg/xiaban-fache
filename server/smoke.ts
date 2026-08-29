import WebSocket from 'ws'

const httpBase = process.env.BACKEND_URL ?? 'http://127.0.0.1:8787'
const wsBase = httpBase.replace(/^http/, 'ws')

type Message = Record<string, any>

function wait(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)) }
function waitFor(log: Message[], predicate: (message: Message) => boolean, timeout = 10000) {
  const start = Date.now()
  return new Promise<Message>((resolve, reject) => {
    const poll = () => {
      const found = log.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - start > timeout) return reject(new Error('timed out waiting for server message'))
      setTimeout(poll, 50)
    }
    poll()
  })
}

async function createRoom() {
  const response = await fetch(`${httpBase}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamName: 'server smoke', departInSeconds: 5, minCrew: 3 }) })
  if (!response.ok) throw new Error(`room create failed: ${response.status}`)
  return await response.json() as { teamCode: string }
}

async function connect(code: string, id: string, log: Message[]) {
  const socket = new WebSocket(wsBase)
  socket.on('message', (raw) => log.push(JSON.parse(String(raw))))
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject) })
  socket.send(JSON.stringify({ type: 'JOIN', teamCode: code, memberId: id, name: id, emoji: '🚂' }))
  await waitFor(log, (message) => message.type === 'WELCOME')
  return socket
}

const room = await createRoom()
const logs = [[], [], []] as Message[][]
const sockets = await Promise.all(logs.map((log, index) => connect(room.teamCode, `smoke-${index}`, log)))
await Promise.all(logs.map((log) => waitFor(log, (message) => message.type === 'STATE' && message.state.phase === 'boarding', 5000)))
sockets.forEach((socket) => socket.send(JSON.stringify({ type: 'SUBMIT_TICKET' })))
// Three people hit the small-crew fast path: the server deliberately skips
// the ceremony and moves straight to the duty-card phase with all three as
// conductors. (A 4+ person room exercises DRAW_RESULT and the 20s ceremony.)
const departingMessages = await Promise.all(logs.map((log) => waitFor(log, (message) => message.type === 'STATE' && message.state.phase === 'departing', 10000)))
const conductorSignature = JSON.stringify(departingMessages[0].state.conductors)
if (!departingMessages.every((message) => JSON.stringify(message.state.conductors) === conductorSignature)) throw new Error('conductor result diverged between clients')
sockets[0].send(JSON.stringify({ type: 'ACCEPT_DUTY' }))
sockets[0].send(JSON.stringify({ type: 'DEPART' }))
await waitFor(logs[1], (message) => message.type === 'STATE' && message.state.phase === 'departed', 3000)
sockets[1].send(JSON.stringify({ type: 'SETTLE' }))
await waitFor(logs[2], (message) => message.type === 'STATE' && message.state.phase === 'settled', 3000)
sockets.forEach((socket) => socket.close())
console.log(`[smoke] ${room.teamCode}: idle → boarding → departing (small-crew fast path) → departed → settled ✓`)
