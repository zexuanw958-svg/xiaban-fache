import { AnimatePresence, motion } from 'motion/react'
import confetti from 'canvas-confetti'
import QRCode from 'qrcode'
import { create } from 'zustand'
import { useEffect, useMemo, useRef, useState } from 'react'
import { demoDraw } from '../drivers/localDemo'
import { createWsDriver, type JoinMessage, type ServerEvent, type TripDriver } from '../drivers/ws'
import { createInitialState, tripReducer } from '../engine/reducer'
import type { Member, Phase, TripEvent, TripState } from '../engine/types'

type AppStore = {
  state: TripState
  dispatch: (event: TripEvent) => void
  hydrate: (state: TripState) => void
}

const useAppStore = create<AppStore>((set) => ({
  state: createInitialState(),
  dispatch: (event) => set(({ state }) => ({ state: tripReducer(state, event) })),
  hydrate: (state) => set({ state }),
}))

const spring = { type: 'spring' as const, stiffness: 310, damping: 22, mass: 0.85 }
const softSpring = { type: 'spring' as const, stiffness: 220, damping: 24 }
const isServerEvent = (event: TripEvent): event is ServerEvent => ['SUBMIT_TICKET', 'WITHDRAW_TICKET', 'DECLINE_DUTY', 'ACCEPT_DUTY', 'DEPART', 'BOARD', 'SETTLE'].includes(event.type)

function useSound() {
  const ctx = useRef<AudioContext | null>(null)
  const beep = (frequency: number, duration: number, volume = 0.05, delay = 0, type: OscillatorType = 'sine') => {
    try {
      ctx.current ??= new AudioContext()
      const oscillator = ctx.current.createOscillator()
      const gain = ctx.current.createGain()
      const time = ctx.current.currentTime + delay
      oscillator.type = type
      oscillator.frequency.value = frequency
      gain.gain.setValueAtTime(volume, time)
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration)
      oscillator.connect(gain).connect(ctx.current.destination)
      oscillator.start(time)
      oscillator.stop(time + duration + 0.03)
    } catch {
      // Audio is deliberately best-effort: iOS needs a user gesture to unlock it.
    }
  }
  return {
    unlock: () => beep(520, 0.03, 0.001),
    tick: () => beep(1250, 0.045, 0.018, 0, 'square'),
    submit: () => beep(720, 0.09, 0.05, 0, 'triangle'),
    reveal: () => { beep(640, 0.1, 0.05, 0, 'triangle'); beep(1040, 0.18, 0.055, 0.1, 'triangle') },
    depart: () => { beep(660, 0.17, 0.08, 0, 'triangle'); beep(880, 0.34, 0.08, 0.17, 'triangle') },
  }
}

function haptic(pattern: number | number[]) {
  try { navigator.vibrate?.(pattern) } catch { /* iOS silently ignores it */ }
}

function burst(big = false) {
  confetti({
    particleCount: big ? 130 : 48,
    spread: big ? 78 : 54,
    startVelocity: big ? 32 : 23,
    gravity: 1.08,
    scalar: big ? 0.95 : 0.72,
    ticks: big ? 165 : 90,
    colors: ['#D9A13B', '#EF8A1E', '#C6884A', '#F3E6C6', '#FBF9F6'],
    origin: { x: 0.5, y: big ? 0.46 : 0.55 },
  })
}

function formatCountdown(departAt: number) {
  const seconds = Math.max(0, Math.floor((departAt - Date.now()) / 1000))
  const h = String(Math.floor(seconds / 3600)).padStart(2, '0')
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const s = String(seconds % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

function Badge({ member, submitted, onClick, compact = false }: { member: Member; submitted: boolean; onClick?: () => void; compact?: boolean }) {
  return (
    <motion.button
      type="button"
      className={`badge ${submitted ? 'is-submitted' : ''} ${compact ? 'is-compact' : ''}`}
      onClick={onClick}
      aria-pressed={submitted}
      whileHover={{ y: -5, rotate: member.isMe ? -1 : 1 }}
      whileTap={{ scale: 0.96 }}
      transition={spring}
    >
      <span className="badge-hole" />
      <span className="badge-avatar">{member.emoji}</span>
      <span className="badge-name">{member.name}</span>
      <span className="badge-role">{member.role}</span>
      <span className="badge-barcode" />
      <AnimatePresence>{submitted && <motion.span className="badge-stamp" initial={{ scale: 2.5, rotate: -18, opacity: 0 }} animate={{ scale: 1, rotate: -12, opacity: 1 }} transition={spring}>已投卡</motion.span>}</AnimatePresence>
    </motion.button>
  )
}

function Banban({ mood }: { mood: 'sleep' | 'wave' | 'drum' | 'run' | 'flat' | 'party' }) {
  return (
    <motion.div className={`banban mood-${mood}`} initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring} aria-label="班班">
      <div className="banban-shadow" />
      <div className="banban-body"><span className="banban-window" /><span className="banban-light" /><span className="banban-eye left" /><span className="banban-eye right" /><span className="banban-mouth" /></div>
      <span className="banban-wheel left" /><span className="banban-wheel right" />
      {mood === 'sleep' && <span className="zzz">Z<span>z</span><i>z</i></span>}
      {mood === 'wave' && <span className="banban-bubble">刷卡了吗？</span>}
      {mood === 'drum' && <span className="drum-stick">╲╱</span>}
      {mood === 'party' && <span className="party-spark">✦ ✧</span>}
    </motion.div>
  )
}

function Header({ state, countdown, roomCode, onOpenRoom, liveMode, connection }: { state: TripState; countdown: string; roomCode: string; onOpenRoom: () => void; liveMode: boolean; connection: 'offline' | 'connecting' | 'online' }) {
  const phaseLabel: Record<Phase, string> = { idle: '平峰待机', boarding: '正在检票', drawing: '摇号进行中', departing: '准备发车', departed: '已发车', settled: '今日收班', suspended: '今日停运' }
  return (
    <>
      <div className="topbar">
        <button type="button" className="brand-mark room-trigger" onClick={onOpenRoom}><img className="brand-bus" src="/art/bus.png" alt="" /> {roomCode} <span className="room-trigger-arrow">↗</span></button>
        <span className={`live-pill ${liveMode ? 'is-live' : ''}`}><i /> {liveMode ? (connection === 'online' ? 'LIVE ROOM' : 'CONNECTING') : 'LOCAL DEMO'}</span>
      </div>
      <section className="route-head">
        <div>
          <p className="eyebrow">下班发车 · 今日班次</p>
          <h1>开往 <em>家</em></h1>
          <p className="route-note">大家都做完了，都在等第一个站起来的人。</p>
        </div>
        <div className="depart-clock"><span>预计发车</span><strong>{state.phase === 'boarding' || state.phase === 'idle' ? countdown : '18:00'}</strong><small>{phaseLabel[state.phase]}</small></div>
      </section>
    </>
  )
}

function RoomModal({ roomCode, onClose, onJoin, onCreate, liveMode }: { roomCode: string; onClose: () => void; onJoin: (name: string, emoji: string) => void; onCreate: () => void | Promise<void>; liveMode: boolean }) {
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('🧑‍💻')
  const [copied, setCopied] = useState(false)
  const [qrCode, setQrCode] = useState('')
  const inviteLink = `${window.location.origin}${window.location.pathname}?room=${roomCode}${liveMode ? '&live=1' : ''}`
  useEffect(() => {
    QRCode.toDataURL(inviteLink, { width: 128, margin: 1, color: { dark: '#211E1A', light: '#FBF9F6' } }).then(setQrCode).catch(() => setQrCode(''))
  }, [inviteLink])
  const copyInvite = async () => {
    try { await navigator.clipboard?.writeText(inviteLink); setCopied(true); window.setTimeout(() => setCopied(false), 1700) } catch { setCopied(false) }
  }
  const emojiChoices = ['🧑‍💻', '🧔', '👩‍🎨', '👨‍🔧', '👧', '😎', '🧑‍🚀', '🐱']
  return <motion.div className="room-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <motion.div className="room-modal" initial={{ y: 28, scale: .95 }} animate={{ y: 0, scale: 1 }} transition={spring}>
      <div className="room-modal-head"><div><p className="eyebrow">车队入口 · {liveMode ? 'LIVE ROOM' : 'OFFLINE DEMO'}</p><h3>加入一班<br /><em>只属于熟人的车。</em></h3></div><button type="button" className="modal-close" onClick={onClose}>×</button></div>
      <div className="room-code-card"><div><span>车队码</span><strong>{roomCode}</strong><small>发车 18:00 · 检票 17:30</small><button type="button" onClick={copyInvite}>{copied ? '已复制 ✓' : '复制邀请链接 ↗'}</button></div>{qrCode && <div className="invite-qr"><img src={qrCode} alt={`加入 ${roomCode} 的二维码`} /><small>扫码入队</small></div>}</div>
      <div className="room-divider"><span>或者</span></div>
      <label className="room-label" htmlFor="room-name">留下你的工牌</label>
      <input id="room-name" className="room-name-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="输入花名，例如：阿轩" maxLength={12} autoFocus />
      <div className="emoji-picker"><span>挑个头像</span><div>{emojiChoices.map((item) => <button type="button" className={emoji === item ? 'selected' : ''} key={item} onClick={() => setEmoji(item)}>{item}</button>)}</div></div>
      <button type="button" className="primary-button room-join-button" disabled={!name.trim()} onClick={() => onJoin(name.trim(), emoji)}>生成工牌，加入 {roomCode} →</button>
      <p className="room-footnote">{liveMode ? '这是实时房间。大家从同一条链接进来，票箱和开奖由服务器统一裁判。' : '这是离线演示房间。把链接发给同事，大家会从同一张入口卡进来；加上 live=1 就会接入 S1 WebSocket。'}</p>
      <button type="button" className="text-button room-create-button" onClick={onCreate}>我是发车人 · 新建一支车队</button>
    </motion.div>
  </motion.div>
}

function IdlePhase({ state, dispatch, liveMode }: { state: TripState; dispatch: (event: TripEvent) => void; liveMode: boolean }) {
  return <motion.div className="phase phase-idle" key="idle" initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
    <div className="phase-meta"><span className="phase-kicker">00 / 平峰</span><span className="meta-rule" /><span>今天也会准点</span></div>
    <div className="idle-mast"><div><p className="eyebrow">下一班 · G604</p><h2>大家都在等<br /><em>一个信号。</em></h2></div><motion.div className="art-mascot" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={spring}><img src="/art/cat-idle.png" alt="打盹的三花猫" /><span className="zzz">Z<span>z</span><i>z</i></span></motion.div></div>
    <div className="idle-count"><span>T-</span><strong>{formatCountdown(state.departAt)}</strong><small>距离 18:00 发车</small></div>
    <div className="idle-streak"><div><span>车队 streak</span><strong>连续准点发车 {state.streak} 班</strong></div><div className="streak-mini">🚂<small>本周</small></div></div>
    <div className="badge-wall"><div className="strip-head"><span>成员工牌墙</span><small>17:30 开始检票</small></div><div className="badge-wall-grid">{state.members.map((member) => <Badge key={member.id} member={member} submitted={false} compact />)}</div></div>
    <button className="primary-button" disabled={liveMode} onClick={() => dispatch({ type: 'DIRECTOR_SET_PHASE', phase: 'boarding' })}>{liveMode ? '等待服务器到点开闸' : '提前开闸检票  →'}</button>
  </motion.div>
}

function BoardingPhase({ state, dispatch, sound, liveMode }: { state: TripState; dispatch: (event: TripEvent) => void; sound: ReturnType<typeof useSound>; liveMode: boolean }) {
  const [dragging, setDragging] = useState(false)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [ticketFlash, setTicketFlash] = useState(false)
  const start = useRef({ x: 0, y: 0 })
  const gateRef = useRef<HTMLDivElement>(null)
  const badgeRef = useRef<HTMLDivElement>(null)
  const me = state.members.find((m) => m.isMe)!
  const voted = state.tickets.some((ticket) => ticket.memberId === me.id)
  const enough = state.tickets.length >= state.minCrew
  const submitMe = () => {
    if (voted) return
    sound.submit(); haptic(10)
    setTicketFlash(true)
    window.setTimeout(() => setTicketFlash(false), 780)
    dispatch({ type: 'SUBMIT_TICKET', memberId: me.id })
    setOffset({ x: 0, y: 0 })
  }
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (voted) return
    sound.unlock()
    start.current = { x: event.clientX, y: event.clientY }
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setOffset({ x: event.clientX - start.current.x, y: event.clientY - start.current.y })
  }
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    const gate = gateRef.current?.getBoundingClientRect()
    const badge = badgeRef.current?.getBoundingClientRect()
    const hit = gate && badge && Math.abs((badge.left + badge.width / 2) - (gate.left + gate.width / 2)) < gate.width * 0.8 && Math.abs((badge.top + badge.height / 2) - (gate.top + gate.height / 2)) < gate.height * 1.25
    if (hit || offset.y < -120) submitMe()
    else setOffset({ x: 0, y: 0 })
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
  }
  return (
    <motion.div className="phase phase-boarding" key="boarding" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} transition={softSpring}>
      <div className="phase-meta"><span className="phase-kicker">01 / 检票</span><span className="meta-rule" /><span>17:30 开始 · 还有同事在路上</span></div>
      <div className="phase-title-row"><div><h2>把工牌刷上，<br /><em>别又坐回去。</em></h2><p>私下约好的一班车，不需要老板批准。</p></div><div className="ticket-counter"><strong>{state.tickets.length}</strong><span>/ {state.members.length}</span><small>已投卡</small></div></div>
      <div className="boarding-stage">
        <div className="gate-label"><span className="signal-dot" /> G604 检票口 <span className="gate-code">A-06</span></div>
        <motion.div ref={gateRef} className="gate" animate={state.tickets.length ? { scale: [1, 1.015, 1] } : {}} transition={{ duration: .34 }}>
          <div className="gate-top"><span className="gate-led" /><span className="gate-led amber" /><span className="gate-led" /></div>
          <div className="gate-slot"><span>刷卡区</span><b>▣</b></div>
          <div className="gate-ticket-slot"><span className="ticket-printer" /> <i>车票会从这里吐出来</i></div>
        </motion.div>
        {ticketFlash && <motion.div className="ticket-flight" initial={{ x: 0, y: 0, scale: .6, rotate: -16, opacity: 0 }} animate={{ x: 104, y: 126, scale: 1, rotate: 5, opacity: [0, 1, 1, 0] }} transition={{ duration: .72, ease: [0.22, 1, .36, 1] }}>🎫</motion.div>}
        <motion.div className="ticket-box-wrap" animate={ticketFlash ? { scale: [1, 1.07, .96, 1] } : { scale: 1 }} transition={{ duration: .34 }}>
          <div className="ticket-box"><div className="box-lid" /><div className="ticket-box-label">票 箱 <span>G604</span></div>{state.tickets.slice(-4).map((ticket) => <motion.div className="mini-ticket" key={ticket.memberId} initial={{ y: -32, opacity: 0, rotate: -12 }} animate={{ y: 0, opacity: 1, rotate: (ticket.seatNo % 2 ? -5 : 5) }} transition={spring}>{state.members.find((member) => member.id === ticket.memberId)?.emoji}<small>{String(ticket.seatNo).padStart(2, '0')}</small></motion.div>)}</div>
          <div className="box-count">已检票 <strong>{state.tickets.length}</strong> / {state.members.length}</div>
        </motion.div>
        <Banban mood="wave" />
      </div>
      <div className="crew-strip"><div className="strip-head"><span>车队成员</span><small>只展示已投的人 · 不点名催票</small></div><div className="crew-avatars">{state.tickets.length === 0 ? <span className="empty-crew">第一张票，等你来盖章</span> : state.tickets.map((ticket) => { const member = state.members.find((item) => item.id === ticket.memberId)!; return <motion.div className="crew-avatar" key={ticket.memberId} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring}><span>{member.emoji}</span><small>{member.name}</small></motion.div> })}</div></div>
      <div className="badge-dock">
        <div className="dock-caption">{voted ? '工牌已刷 · 车票在箱里' : '按住工牌，拖向上面的刷卡区'}</div>
        <motion.div ref={badgeRef} className={`drag-badge ${dragging ? 'is-dragging' : ''} ${voted ? 'is-done' : ''}`} style={{ x: offset.x, y: offset.y }} animate={!dragging ? { x: offset.x, y: offset.y } : undefined} transition={spring} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') submitMe() }}>
          <span className="lanyard" /><span className="drag-avatar">{me.emoji}</span><span className="drag-copy"><b>{me.name}</b><small>{voted ? '已生成车票' : '承诺装置 · 今日有效'}</small></span><span className="drag-arrow">{voted ? '✓' : '↗'}</span>
        </motion.div>
        <button className="text-button" onClick={() => voted ? dispatch({ type: 'WITHDRAW_TICKET', memberId: me.id }) : submitMe()}>{voted ? '活儿回来了？撤回车票' : '点一下也能刷（触屏备用）'}</button>
      </div>
      <div className="phase-actions"><button className="primary-button" disabled={liveMode || !enough} onClick={() => { sound.tick(); demoDraw(state, dispatch) }}>{liveMode ? '等服务器到点开奖' : enough ? '到点开奖  →' : `还差 ${state.minCrew - state.tickets.length} 人才能开奖`}</button><span className="action-hint">{liveMode ? 'T-0 由服务器统一裁判' : `满 ${state.minCrew} 人 · 系统随机抽今天的启动键`}</span></div>
    </motion.div>
  )
}

function DrawingPhase({ state, sound }: { state: TripState; sound: ReturnType<typeof useSound> }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Date.now() - (state.drawStartedAt ?? Date.now())), 100)
    return () => window.clearInterval(timer)
  }, [state.drawStartedAt])
  const revealIndex = Math.min(state.conductors.length, Math.max(0, Math.floor((elapsed - 1800) / 1600) + 1))
  useEffect(() => { if (revealIndex > 0) { sound.reveal(); haptic(revealIndex === state.conductors.length ? [30, 50, 50] : 8) } }, [revealIndex])
  const revealed = state.conductors.slice(0, revealIndex).map((id) => state.members.find((member) => member.id === id)!).filter(Boolean)
  return (
    <motion.div className="phase phase-drawing" key="drawing" initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} transition={softSpring}>
      <div className="phase-meta"><span className="phase-kicker">02 / 开奖</span><span className="meta-rule" /><span>结果先定，悬念后演</span></div>
      <div className="drawing-title"><h2>今天谁来<br /><em>按启动键？</em></h2><span className="draw-timer mono">00:{String(Math.max(0, 20 - Math.floor(elapsed / 1000))).padStart(2, '0')}</span></div>
      <div className="draw-stage"><Banban mood="drum" /><motion.div className="lottery-drum" animate={{ rotate: elapsed < 5400 ? [-3, 3, -2, 4, -3] : 0 }} transition={{ duration: .52, repeat: elapsed < 5400 ? Infinity : 0, ease: 'easeInOut' }}><img className="drum-art" src="/art/drum.png" alt="摇号鼓" /></motion.div><div className="draw-orbit">{state.tickets.map((ticket, index) => <span className="orbit-ticket" key={ticket.memberId} style={{ '--i': index, '--total': state.tickets.length } as React.CSSProperties}>{state.members.find((member) => member.id === ticket.memberId)?.emoji}</span>)}</div></div>
      <div className="reveal-label">{revealed.length === 0 ? '摇鼓中 · 别偷看' : revealed.length < state.conductors.length ? `第 ${revealed.length} 张 · 翻面中` : '列车长已就位'}</div>
      <div className="winner-row">{state.conductors.map((id, index) => { const member = state.members.find((item) => item.id === id)!; const isRevealed = index < revealIndex; return <motion.div className={`winner-ticket ${isRevealed ? 'revealed' : ''}`} key={id} initial={{ y: 28, opacity: 0 }} animate={{ y: isRevealed ? 0 : 8, opacity: 1 }} transition={{ ...spring, delay: index * .05 }}><div className="ticket-face ticket-back"><span>G604</span><b>?</b></div><div className="ticket-face ticket-front"><span className="winner-avatar">{member.emoji}</span><strong>{member.name}</strong><small>座号 {String(state.tickets.find((ticket) => ticket.memberId === id)?.seatNo ?? index + 1).padStart(2, '0')}</small><span className="conductor-stamp">列车长</span></div></motion.div> })}</div>
      <p className="draw-footer">不是他们想走，是车到点了。</p>
    </motion.div>
  )
}

function DepartingPhase({ state, dispatch, sound }: { state: TripState; dispatch: (event: TripEvent) => void; sound: ReturnType<typeof useSound> }) {
  const me = state.members.find((member) => member.isMe)!
  const isConductor = state.conductors.includes(me.id)
  const accepted = state.acceptedDuties.includes(me.id)
  const [slider, setSlider] = useState(0)
  const accept = () => { sound.submit(); haptic(12); dispatch({ type: 'ACCEPT_DUTY', memberId: me.id }) }
  const depart = () => { sound.depart(); haptic([40, 70, 40]); dispatch({ type: 'DEPART', memberId: me.id }) }
  return (
    <motion.div className="phase phase-departing" key="departing" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
      <div className="phase-meta"><span className="phase-kicker">03 / 发车</span><span className="meta-rule" /><span>全队都走 · TA 只是按启动键</span></div>
      <div className="departing-title"><h2>{isConductor ? <>发车令<br /><em>到你手里了。</em></> : <>列车长正在<br /><em>收拾行李…</em></>}</h2><span className="departing-stamp">G604<br /><small>18:00</small></span></div>
      {isConductor ? <>
        <div className={`duty-card ${accepted ? 'accepted' : ''}`}><div className="duty-card-top"><span className="gold-chip">列车长证</span><span className="duty-number">NO. {String(state.tickets.find((ticket) => ticket.memberId === me.id)?.seatNo ?? 1).padStart(2, '0')}</span></div><div className="duty-person"><span>{me.emoji}</span><div><strong>{me.name}</strong><small>今天负责把大家捞起来</small></div></div>{accepted ? <div className="checklist">{['合上电脑', '背上包', '站起来'].map((item, index) => <motion.button type="button" className="check-row done" key={item} initial={{ x: -12, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ ...spring, delay: index * .08 }}><span>✓</span>{item}</motion.button>)}</div> : <div className="duty-actions"><button className="primary-button gold" onClick={accept}>接令，今天我来带队</button><button className="text-button" onClick={() => dispatch({ type: 'DECLINE_DUTY', memberId: me.id })}>今天真不行 · 婉拒重抽</button></div>}</div>
        {accepted && <div className="slide-wrap"><div className="slide-copy"><strong>准备好了？</strong><span>滑到底，给全队一个一起走的信号</span></div><div className="slide-track"><span className="slide-track-text">滑动发车 →</span><input aria-label="滑动发车" type="range" min="0" max="100" value={slider} onChange={(event) => { const value = Number(event.target.value); setSlider(value); if (value >= 98) depart() }} /><span className="slide-thumb">→</span></div></div>}
      </> : <div className="passenger-card"><div className="passenger-icon">🧳</div><strong>再等 10 秒，车长会按下启动键</strong><p>你不用证明自己最早做完。车一开，大家一起走。</p><div className="passenger-line"><span />正在收拾 <b>{state.conductors.map((id) => state.members.find((member) => member.id === id)?.name).join('、')}</b><span /></div><button className="secondary-button" onClick={() => { sound.depart(); dispatch({ type: 'DEPART', memberId: state.conductors[0] ?? me.id }) }}>模拟列车长发车</button></div>}
      <div className="departing-crew">{state.members.map((member) => <div className={`tiny-member ${state.conductors.includes(member.id) ? 'is-conductor' : ''}`} key={member.id}><span>{member.emoji}</span><small>{member.name}</small></div>)}</div>
    </motion.div>
  )
}

function DepartedPhase({ state, dispatch, sound }: { state: TripState; dispatch: (event: TripEvent) => void; sound: ReturnType<typeof useSound> }) {
  const [boarded, setBoarded] = useState(false)
  const me = state.members.find((member) => member.isMe)!
  const board = () => { setBoarded(true); haptic(18); dispatch({ type: 'BOARD', memberId: me.id }) }
  return (
    <motion.div className="phase phase-departed" key="departed" initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} transition={softSpring}>
      <div className="phase-meta"><span className="phase-kicker">04 / 车厢</span><span className="meta-rule" /><span>跟上这班车</span></div>
      <div className="departed-title"><div><p className="eyebrow">汽笛已响</p><h2>G604 <em>已发车</em></h2></div><div className="departed-time">18:00<small>准点</small></div></div>
      <div className="train-scene">
        <div className="track-line" />
        <motion.div className="train" initial={{ x: -320 }} animate={{ x: 0 }} transition={{ ...spring, delay: .15 }}>
          <div className="locomotive"><span className="train-light" /><b>🚂</b><small>G604</small></div>
          {state.members.map((member, index) => (
            <motion.div className={`train-car ${state.conductors.includes(member.id) ? 'conductor-car' : ''}`} key={member.id} initial={{ y: -20, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ ...spring, delay: .42 + index * .08 }}>
              <span>{member.emoji}</span><small>{member.name}</small>
            </motion.div>
          ))}
        </motion.div>
        <motion.img className="art-cat-edge" src="/art/cat-departed.png" alt="躺平的橘猫" initial={{ y: -14, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ ...spring, delay: .6 }} />
      </div>
      <div className="board-status"><div><strong>{state.members.length}</strong><span>/{state.members.length} 已上车</span></div><span className="board-status-copy">不催你，车会等到下一站。</span></div>
      <button className={`primary-button ${boarded ? 'is-complete' : ''}`} onClick={board} disabled={boarded}>{boarded ? '✓ 已上车，今天不再加班' : '我上车了  →'}</button>
      <button className="secondary-button" onClick={() => { sound.depart(); dispatch({ type: 'SETTLE' }) }}>演示结束 · 结算今日班次</button>
    </motion.div>
  )
}

function EndPhase({ state, dispatch, liveMode }: { state: TripState; dispatch: (event: TripEvent) => void; liveMode: boolean }) {
  const suspended = state.phase === 'suspended'
  return <motion.div className={`phase phase-end ${suspended ? 'is-suspended' : ''}`} key={state.phase} initial={{ opacity: 0, scale: .95 }} animate={{ opacity: 1, scale: 1 }} transition={softSpring}>
    <div className="end-mast"><motion.img className="art-mascot-end" src={suspended ? '/art/cat-suspended.png' : '/art/cat-settled.png'} alt="吉祥物" initial={{ scale: .8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring} /><span className="end-kicker">{suspended ? '今日停运' : '今日收班'}</span></div>
    <h2>{suspended ? <>今天没凑齐，<em>明天再发。</em></> : <>准点下班，<em>明天见。</em></>}</h2>
    <div className="settle-card"><div><span className="settle-label">G604</span><strong>{suspended ? '客流不足 · streak 冻结' : '准点发出 · 全员 6 人'}</strong><small>{suspended ? '不清零，不追责，明天继续' : '下班不是逃跑，是班车到站了'}</small></div>{!suspended && <div className="streak-badge"><span>连续</span><strong>{state.streak}</strong><small>班</small></div>}</div>
    {!suspended && <div className="streak-calendar"><span>近 7 日准点记录</span><div>{['一','二','三','四','五','六','今'].map((day, i) => <div className={i === 6 ? 'today' : ''} key={day}><small>{day}</small><b>{i === 6 ? '🚂' : '●'}</b></div>)}</div></div>}
    <p className="end-quote">「第一个走」不该是个人英雄主义，<br />它可以只是系统今天抽到了你。</p>
    <button className="primary-button" disabled={liveMode} onClick={() => dispatch({ type: 'RESET' })}>{liveMode ? '本班已结束 · 等待下一班' : '再发一班车  ↗'}</button>
  </motion.div>
}

function Director({ phase, dispatch, liveMode }: { phase: Phase; dispatch: (event: TripEvent) => void; liveMode: boolean }) {
  const [open, setOpen] = useState(new URLSearchParams(location.search).has('director'))
  const phases: Phase[] = ['idle', 'boarding', 'drawing', 'departing', 'departed', 'settled', 'suspended']
  if (liveMode) return <div className="director live-lock"><span className="live-lock-dot" /> SERVER CLOCK · {phase}</div>
  return <div className={`director ${open ? 'open' : ''}`}><button className="director-toggle" onClick={() => setOpen(!open)}>{open ? '收起导演台' : '导演台'} <span>⌄</span></button>{open && <div className="director-panel"><div><strong>OFFLINE SHOW CONTROL</strong><small>跳相位 · 无网络也能演</small></div><div className="director-grid">{phases.map((item) => <button className={phase === item ? 'active' : ''} key={item} onClick={() => dispatch({ type: 'DIRECTOR_SET_PHASE', phase: item })}>{item}</button>)}</div><button className="director-reset" onClick={() => dispatch({ type: 'RESET' })}>↺ 重置这班车</button></div>}</div>
}

export default function App() {
  const { state, dispatch, hydrate } = useAppStore()
  const sound = useSound()
  const [now, setNow] = useState(Date.now())
  const [roomCode, setRoomCode] = useState(() => new URLSearchParams(window.location.search).get('room')?.toUpperCase() || 'G604')
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const liveMode = params.has('live')
  const projectionMode = params.has('projection')
  const storedProfile = useMemo(() => {
    try { return JSON.parse(localStorage.getItem('fache-member') ?? 'null') as { memberId: string; name: string; emoji: string; roomCode?: string } | null } catch { return null }
  }, [])
  const queryRoom = params.get('room')?.toUpperCase()
  const [profile, setProfile] = useState<{ memberId: string; name: string; emoji: string } | null>(() => storedProfile ?? (queryRoom ? null : { memberId: 'me', name: '你', emoji: '🧑‍💻' }))
  const [roomOpen, setRoomOpen] = useState(() => Boolean(queryRoom && !storedProfile))
  const [connection, setConnection] = useState<'offline' | 'connecting' | 'online'>(liveMode ? 'connecting' : 'offline')
  const [toast, setToast] = useState<string>()
  const driverRef = useRef<TripDriver | null>(null)
  const previousPhase = useRef<Phase>(state.phase)
  const countdown = useMemo(() => formatCountdown(state.departAt), [state.departAt, now])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [])
  useEffect(() => {
    if (!liveMode || !profile) return
    const wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const backendHost = window.location.hostname || 'localhost'
    const join: JoinMessage = { type: 'JOIN', teamCode: roomCode, memberId: profile.memberId, name: profile.name, emoji: profile.emoji }
    const driver = createWsDriver(`${wsProtocol}://${backendHost}:8787`, join)
    driverRef.current = driver
    setConnection('connecting')
    const unsubscribe = driver.subscribe((remoteState) => {
      hydrate({ ...remoteState, members: remoteState.members.map((member) => ({ ...member, isMe: member.id === profile.memberId })) })
      setConnection('online')
    })
    driver.connect()
    return () => { unsubscribe(); driver.disconnect(); if (driverRef.current === driver) driverRef.current = null; setConnection('offline') }
  }, [hydrate, liveMode, profile, roomCode])
  useEffect(() => {
    if (liveMode || state.phase !== 'boarding') return
    const demoMembers = ['laowang', 'momo', 'dapeng', 'qiqi', 'xiaohei']
    const timers = demoMembers.map((id, index) => window.setTimeout(() => { if (!useAppStore.getState().state.tickets.some((ticket) => ticket.memberId === id)) { sound.submit(); useAppStore.getState().dispatch({ type: 'SUBMIT_TICKET', memberId: id }) } }, 1300 + index * 1850))
    return () => timers.forEach(window.clearTimeout)
  }, [liveMode, state.phase])
  useEffect(() => {
    if (liveMode || state.phase !== 'drawing') return
    const duration = state.tickets.length <= state.minCrew ? 1200 : 20000
    const timer = window.setTimeout(() => useAppStore.getState().dispatch({ type: 'DIRECTOR_SET_PHASE', phase: 'departing' }), duration)
    return () => window.clearTimeout(timer)
  }, [liveMode, state.phase, state.drawStartedAt, state.tickets.length, state.minCrew])
  useEffect(() => {
    if (state.phase !== previousPhase.current) {
      if (state.phase === 'drawing') burst(false)
      if (state.phase === 'departed') burst(false)
      if (state.phase === 'settled') burst(true)
      previousPhase.current = state.phase
    }
  }, [state.phase])
  const phase = state.phase
  const isEnd = phase === 'settled' || phase === 'suspended'
  const dispatchEvent = (event: TripEvent) => {
    if (liveMode && driverRef.current && isServerEvent(event)) driverRef.current.send(event)
    else dispatch(event)
  }
  useEffect(() => {
    if (!state.notification) return
    setToast(state.notification)
    const timer = window.setTimeout(() => setToast(undefined), 2800)
    return () => window.clearTimeout(timer)
  }, [state.notification])
  const joinRoom = (name: string, emoji: string) => {
    const memberId = liveMode ? (storedProfile?.memberId ?? `guest-${Date.now().toString(36)}`) : 'me'
    const nextProfile = { memberId, name, emoji }
    setProfile(nextProfile)
    if (!liveMode) dispatch({ type: 'ADD_MEMBER', member: { id: memberId, name, emoji, role: '就等一班车', isMe: true } })
    try { localStorage.setItem('fache-member', JSON.stringify({ ...nextProfile, roomCode })) } catch { /* best effort */ }
    setRoomOpen(false)
  }
  const createRoom = async () => {
    if (liveMode) {
      try {
        const base = `${window.location.protocol}//${window.location.hostname}:8787`
        const response = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamName: '新车队', minCrew: 3 }) })
        const data = await response.json() as { teamCode: string }
        setRoomCode(data.teamCode)
        setProfile(null)
        window.history.replaceState({}, '', `${window.location.pathname}?room=${data.teamCode}&live=1`)
        setRoomOpen(true)
        return
      } catch { /* fallback to a local code if the backend is not reachable */ }
    }
    const suffix = String(Math.floor(100 + Math.random() * 899))
    setRoomCode(`G${suffix}`)
    window.history.replaceState({}, '', `${window.location.pathname}?room=G${suffix}${liveMode ? '&live=1' : ''}`)
  }
  return <div className={`app-root ${projectionMode ? 'is-projection' : ''}`} onPointerDown={() => sound.unlock()}>
    <div className="ambient ambient-one" /><div className="ambient ambient-two" />
    <main className="phone-shell"><div className="phone-notch" /><div className="phone-screen" data-phase={phase}><Header state={state} countdown={countdown} roomCode={roomCode} onOpenRoom={() => setRoomOpen(true)} liveMode={liveMode} connection={connection} />{toast && <div className="notification-toast" role="status" aria-live="polite"><span className="toast-icon">✦</span>{toast}</div>}<div className="screen-scroll"><AnimatePresence mode="wait" initial={false}>{phase === 'idle' && <IdlePhase state={state} dispatch={dispatchEvent} liveMode={liveMode} />}{phase === 'boarding' && <BoardingPhase state={state} dispatch={dispatchEvent} sound={sound} liveMode={liveMode} />}{phase === 'drawing' && <DrawingPhase state={state} sound={sound} />}{phase === 'departing' && <DepartingPhase state={state} dispatch={dispatchEvent} sound={sound} />}{phase === 'departed' && <DepartedPhase state={state} dispatch={dispatchEvent} sound={sound} />}{isEnd && <EndPhase state={state} dispatch={dispatchEvent} liveMode={liveMode} />}</AnimatePresence></div><div className="phone-home" /></div></main>
    <aside className="desktop-copy"><p className="desktop-kicker">A SMALL RITUAL<br />FOR A BIG RELIEF</p><h2>不是他们想走，<br /><em>是车到点了。</em></h2><p>把“第一个站起来”从需要勇气的个人行为，变成系统派发的角色。每天下班前，发一班只属于熟人的小车。</p><div className="copy-rule" /><div className="copy-facts"><span><b>01</b> 私下组队</span><span><b>02</b> 工牌投票</span><span><b>03</b> 随机领队</span></div></aside>
    <Director phase={phase} dispatch={dispatch} liveMode={liveMode} />
    <AnimatePresence>{roomOpen && <RoomModal roomCode={roomCode} onClose={() => setRoomOpen(false)} onJoin={joinRoom} onCreate={createRoom} liveMode={liveMode} />}</AnimatePresence>
  </div>
}
