export type Phase =
  | 'idle'
  | 'boarding'
  | 'drawing'
  | 'departing'
  | 'departed'
  | 'settled'
  | 'suspended'

export interface Member {
  id: string
  name: string
  emoji: string
  role: string
  isMe?: boolean
}

export interface Ticket {
  memberId: string
  seatNo: number
  late?: boolean
}

export interface TripState {
  phase: Phase
  departAt: number
  members: Member[]
  tickets: Ticket[]
  conductors: string[]
  declined: string[]
  boarded: string[]
  acceptedDuties: string[]
  streak: number
  minCrew: number
  drawStartedAt?: number
  notification?: string
}

export type TripEvent =
  | { type: 'TICK'; now?: number }
  | { type: 'ADD_MEMBER'; member: Member }
  | { type: 'SUBMIT_TICKET'; memberId: string; late?: boolean }
  | { type: 'WITHDRAW_TICKET'; memberId: string }
  | { type: 'DRAW_RESULT'; conductorIds: string[]; drawStartAt?: number }
  | { type: 'ACCEPT_DUTY'; memberId: string }
  | { type: 'DECLINE_DUTY'; memberId: string }
  | { type: 'DEPART'; memberId: string }
  | { type: 'BOARD'; memberId: string }
  | { type: 'SETTLE' }
  | { type: 'SUSPEND' }
  | { type: 'DIRECTOR_SET_PHASE'; phase: Phase }
  | { type: 'RESET' }
