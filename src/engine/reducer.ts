import { pickConductors } from './rules'
import type { TripEvent, TripState } from './types'

export const defaultMembers: TripState['members'] = [
  { id: 'me', name: '你', emoji: '🧑‍💻', role: '就等一班车', isMe: true },
  { id: 'laowang', name: '老王', emoji: '🧔', role: '已完成今日份' },
  { id: 'momo', name: 'Momo', emoji: '👩‍🎨', role: '已完成今日份' },
  { id: 'dapeng', name: '大鹏', emoji: '👨‍🔧', role: '已完成今日份' },
  { id: 'qiqi', name: '七七', emoji: '👧', role: '已完成今日份' },
  { id: 'xiaohei', name: '小黑', emoji: '😎', role: '已完成今日份' },
]

const initialStreak = () => {
  try {
    return Number(localStorage.getItem('fache-streak') ?? 12) || 12
  } catch {
    return 12
  }
}

export function createInitialState(): TripState {
  const now = Date.now()
  return {
    phase: 'boarding',
    departAt: now + 8 * 60 * 1000,
    members: defaultMembers,
    tickets: [],
    conductors: [],
    declined: [],
    boarded: [],
    acceptedDuties: [],
    streak: initialStreak(),
    minCrew: 3,
  }
}

function persistStreak(value: number) {
  try {
    localStorage.setItem('fache-streak', String(value))
  } catch {
    // localStorage is best-effort on private browsing.
  }
}

export function tripReducer(state: TripState, event: TripEvent): TripState {
  switch (event.type) {
    case 'TICK': {
      if (state.phase === 'idle' && (event.now ?? Date.now()) >= state.departAt - 30 * 60 * 1000) {
        return { ...state, phase: 'boarding', notification: '🚌 G604 开始检票，干完活的把工牌刷上' }
      }
      return state
    }
    case 'ADD_MEMBER': {
      const exists = state.members.some((member) => member.id === event.member.id)
      return {
        ...state,
        members: exists
          ? state.members.map((member) => member.id === event.member.id ? { ...member, ...event.member } : member)
          : [...state.members, event.member],
        notification: exists ? undefined : `${event.member.name} 已加入车队`,
      }
    }
    case 'SUBMIT_TICKET': {
      if (state.tickets.some((ticket) => ticket.memberId === event.memberId)) return state
      const ticket: TripState['tickets'][number] = {
        memberId: event.memberId,
        seatNo: state.tickets.length + 1,
        late: event.late,
      }
      return { ...state, tickets: [...state.tickets, ticket], notification: event.late ? '补票成功，赶上这班车' : undefined }
    }
    case 'WITHDRAW_TICKET':
      if (state.phase !== 'boarding') return state
      return {
        ...state,
        tickets: state.tickets
          .filter((ticket) => ticket.memberId !== event.memberId)
          .map((ticket, index) => ({ ...ticket, seatNo: index + 1 })),
        notification: '车票已撤回，活儿突然又来了？',
      }
    case 'DRAW_RESULT':
      return {
        ...state,
        phase: 'drawing',
        conductors: event.conductorIds,
        drawStartedAt: event.drawStartAt ?? Date.now(),
        notification: '开奖开始：今天谁来按启动键？',
      }
    case 'ACCEPT_DUTY':
      return {
        ...state,
        acceptedDuties: state.acceptedDuties.includes(event.memberId)
          ? state.acceptedDuties
          : [...state.acceptedDuties, event.memberId],
        notification: '接令成功，收拾好就发车',
      }
    case 'DECLINE_DUTY': {
      const nextPool = state.tickets
        .map((ticket) => ticket.memberId)
        .filter((memberId) => !state.declined.includes(memberId) && memberId !== event.memberId)
      const replacement = nextPool.find((memberId) => !state.conductors.includes(memberId))
      return {
        ...state,
        declined: [...state.declined, event.memberId],
        conductors: replacement ? [...state.conductors.filter((id) => id !== event.memberId), replacement] : state.conductors.filter((id) => id !== event.memberId),
        notification: replacement ? '婉拒成功，系统补抽下一位' : '已记录婉拒，剩下的列车长接令',
      }
    }
    case 'DEPART':
      return {
        ...state,
        phase: 'departed',
        boarded: state.tickets.map((ticket) => ticket.memberId),
        notification: '🚂 G604 已发车，跟上！',
      }
    case 'BOARD':
      return state.boarded.includes(event.memberId)
        ? state
        : { ...state, boarded: [...state.boarded, event.memberId] }
    case 'SETTLE': {
      const streak = state.streak + 1
      persistStreak(streak)
      return { ...state, phase: 'settled', streak, notification: '叮咚：今日准点发车，streak +1' }
    }
    case 'SUSPEND':
      return { ...state, phase: 'suspended', notification: '今日客流不足，streak 冻结保留' }
    case 'DIRECTOR_SET_PHASE':
      return { ...state, phase: event.phase, notification: undefined }
    case 'RESET':
      return createInitialState()
    default:
      return state
  }
}
