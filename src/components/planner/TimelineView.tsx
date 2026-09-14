'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { format, differenceInMinutes, startOfDay, parseISO, isSameDay, addDays } from 'date-fns'
import { PlannerItem } from '@/types'
import { createItem, updateItem, deleteItem } from '@/app/actions/items'
import { logUndo, performUndo } from '@/app/actions/undo'
import { updateProfile } from '@/app/actions/profile'

const MIN_START = 360  // 06:00 (6 AM)
const MIN_END = 1440   // 24:00 (12 AM next day)
const SNAP_MINUTES = 5

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmt24 = (m: number) => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60)
const fmt12h = (h: number) => (h === 12 ? '12 PM' : h === 0 || h === 24 ? '12 AM' : h > 12 ? (h - 12) + ' PM' : h + ' AM')
const toMin = (str: string) => {
  const [h, m] = str.split(':').map(Number)
  return h * 60 + m
}

interface TimelineViewProps {
  initialItems: PlannerItem[]
  day: string
  cascadePreference: string
  initialTimezone?: string
}

interface LocalBlock {
  id: string
  type: 'task' | 'buffer'
  title: string
  startMin: number
  endMin: number
  completed: boolean
  completedAt?: string | null
  sortOrder: number
}

export default function TimelineView({
  initialItems,
  day,
  cascadePreference,
  initialTimezone = 'America/Los_Angeles'
}: TimelineViewProps) {
  const router = useRouter()

  // Dynamic viewport detection: purely automatic by viewport width
  const [isMobile, setIsMobile] = useState(false)

  // Local state for planner blocks
  const [blocks, setBlocks] = useState<LocalBlock[]>([])
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())

  // Settings & preferences
  const [cascadeMode, setCascadeMode] = useState<'always' | 'ask' | 'never'>(
    (cascadePreference as 'always' | 'ask' | 'never') || 'ask'
  )
  const [timezone, setTimezone] = useState(initialTimezone)

  // History stack for instant local undo
  const [historyStack, setHistoryStack] = useState<LocalBlock[][]>([])

  // UI Modals & Panels
  const [modal, setModal] = useState<{
    mode: 'add' | 'edit'
    id?: string
    draft: {
      type: 'task' | 'buffer'
      title: string
      startStr: string
      endStr: string
    }
  } | null>(null)

  const [panel, setPanel] = useState<'settings' | 'review' | null>(null)
  const [cascadePrompt, setCascadePrompt] = useState<{
    chain: string[]
    delta: number
    count: number
  } | null>(null)

  const [toast, setToast] = useState<{ msg: string } | null>(null)
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Drag ref
  const dragRef = useRef<{
    mode: 'move' | 'resize'
    id: string
    startY: number
    origStart: number
    origEnd: number
  } | null>(null)

  const trackRef = useRef<HTMLDivElement>(null)

  // Accent color tokens
  const accent = '#d9a441'
  const accentText = 'oklch(0.18 0.01 90)'

  // Check screen width for automatic responsive behavior (no user switch)
  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768)
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // Map initialItems from Supabase into LocalBlocks
  useEffect(() => {
    const baseDay = parseISO(day)
    const dayStart = startOfDay(baseDay)

    const mapped: LocalBlock[] = initialItems
      .filter(i => !i.is_deleted)
      .map(i => {
        const start = parseISO(i.start_time)
        const end = parseISO(i.end_time)
        const startMin = differenceInMinutes(start, dayStart)
        const endMin = differenceInMinutes(end, dayStart)
        return {
          id: i.id,
          type: (i.is_buffer ? 'buffer' : 'task') as 'task' | 'buffer',
          title: i.title || (i.is_buffer ? 'Buffer' : 'Untitled'),
          startMin: Math.max(0, startMin),
          endMin: Math.max(startMin + 5, endMin),
          completed: !!i.is_completed,
          completedAt: i.completed_at,
          sortOrder: i.sort_order || 0
        }
      })
      .sort((a, b) => a.startMin - b.startMin)

    setBlocks(mapped)
  }, [initialItems, day])

  // Real-time clock update
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30000)
    return () => clearInterval(interval)
  }, [])

  // Keyboard shortcut for Undo (Ctrl+Z / Cmd+Z)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        handleUndo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [blocks, historyStack])

  // Toast notification
  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ msg })
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }

  // Push to undo stack
  const pushLocalHistory = () => {
    setHistoryStack(prev => [...prev.slice(-19), JSON.parse(JSON.stringify(blocks))])
  }

  // Handle undo (local + server sync)
  const handleUndo = async () => {
    if (historyStack.length > 0) {
      const prev = historyStack[historyStack.length - 1]
      setHistoryStack(prevStack => prevStack.slice(0, -1))
      setBlocks(prev)
      setToast(null)
      setCascadePrompt(null)
    }

    try {
      const res = await performUndo()
      if (res.success && res.day && res.day !== day) {
        router.push(`/planner?day=${res.day}`)
      }
      showToast('Action undone')
    } catch (e) {
      console.error('Undo sync error:', e)
    }
  }

  // Pixels per minute based on screen size (1.2px/min on mobile, 1.6px/min on desktop)
  const pxPerMin = (isMobile ? 72 : 96) / 60
  const gutterWidth = isMobile ? 54 : 68
  const blockRight = isMobile ? 8 : 20

  // Date helpers
  const targetDate = parseISO(day)
  const isToday = isSameDay(targetDate, now)
  const nowMinutes = differenceInMinutes(now, startOfDay(now))
  const nowTop = (nowMinutes - MIN_START) * pxPerMin
  const dateLabel = format(targetDate, isMobile ? 'EEE, MMM d' : 'EEEE, MMMM do')

  const changeDate = (delta: number) => {
    const next = addDays(targetDate, delta)
    const nextStr = format(next, 'yyyy-MM-dd')
    router.push(`/planner?day=${nextStr}`)
  }

  const goToday = () => {
    const todayStr = format(new Date(), 'yyyy-MM-dd')
    router.push(`/planner?day=${todayStr}`)
  }

  // Toggle complete
  const toggleComplete = async (id: string) => {
    pushLocalHistory()
    const target = blocks.find(b => b.id === id)
    if (!target) return

    const nextCompleted = !target.completed
    const nextCompletedAt = nextCompleted ? new Date().toISOString() : null

    setBlocks(prev => prev.map(b => b.id === id ? { ...b, completed: nextCompleted, completedAt: nextCompletedAt } : b))

    try {
      await updateItem(id, { is_completed: nextCompleted, completed_at: nextCompletedAt })
      await logUndo('update', { items: [{ id, is_completed: target.completed, completed_at: target.completedAt }] }, day)
    } catch (err) {
      console.error('Error toggling complete:', err)
    }
  }

  // Delete block
  const handleDeleteBlock = async (id: string) => {
    pushLocalHistory()
    const target = blocks.find(b => b.id === id)
    if (!target) return

    setBlocks(prev => prev.filter(b => b.id !== id))
    setSelectedBlockId(null)
    setModal(null)
    showToast('Block deleted')

    try {
      await deleteItem(id)
      await logUndo('update', { items: [{ id, is_deleted: false }] }, day)
    } catch (err) {
      console.error('Error deleting item:', err)
    }
  }

  // Modal open/close
  const openAdd = () => {
    setModal({
      mode: 'add',
      draft: {
        type: 'task',
        title: '',
        startStr: fmt24(Math.min(MIN_END - 30, Math.max(MIN_START, Math.floor(nowMinutes / 30) * 30 || 600))),
        endStr: fmt24(Math.min(MIN_END, Math.max(MIN_START + 30, (Math.floor(nowMinutes / 30) * 30 || 600) + 30)))
      }
    })
  }

  const openEdit = (block: LocalBlock) => {
    setModal({
      mode: 'edit',
      id: block.id,
      draft: {
        type: block.type,
        title: block.type === 'buffer' ? (block.title === 'Buffer' ? '' : block.title) : block.title,
        startStr: fmt24(block.startMin),
        endStr: fmt24(block.endMin)
      }
    })
  }

  const saveDraft = async () => {
    if (!modal) return
    const { mode, id, draft } = modal
    const startMin = toMin(draft.startStr)
    const endMin = toMin(draft.endStr)

    if (endMin <= startMin) {
      showToast('End time must be after start')
      return
    }

    pushLocalHistory()

    const startIso = new Date(`${day}T${fmt24(startMin)}:00`).toISOString()
    const endIso = new Date(`${day}T${fmt24(endMin)}:00`).toISOString()

    if (mode === 'add') {
      const isBuffer = draft.type === 'buffer'
      const title = isBuffer ? (draft.title.trim() || 'Buffer') : (draft.title.trim() || 'Untitled')

      const tempId = 'temp-' + Date.now()
      const newBlock: LocalBlock = {
        id: tempId,
        type: draft.type,
        title,
        startMin,
        endMin,
        completed: false,
        sortOrder: blocks.length + 1
      }
      setBlocks(prev => [...prev, newBlock].sort((a, b) => a.startMin - b.startMin))
      setModal(null)
      showToast(isBuffer ? 'Buffer added' : 'Task added')

      try {
        const saved = await createItem({
          title,
          start_time: startIso,
          end_time: endIso,
          is_buffer: isBuffer,
          is_completed: false,
          day
        })
        setBlocks(prev => prev.map(b => b.id === tempId ? { ...b, id: saved.id } : b))
        await logUndo('create', { id: saved.id }, day)
      } catch (err) {
        console.error('Error creating item:', err)
      }
    } else if (mode === 'edit' && id) {
      const isBuffer = draft.type === 'buffer'
      const title = isBuffer ? (draft.title.trim() || 'Buffer') : (draft.title.trim() || 'Untitled')

      setBlocks(prev =>
        prev
          .map(b => (b.id === id ? { ...b, type: draft.type, title, startMin, endMin } : b))
          .sort((a, b) => a.startMin - b.startMin)
      )
      setModal(null)
      showToast('Block updated')

      try {
        await updateItem(id, {
          title,
          start_time: startIso,
          end_time: endIso,
          is_buffer: isBuffer
        })
      } catch (err) {
        console.error('Error updating item:', err)
      }
    }
  }

  // Pointer Drag & Resize Handlers
  const startDrag = (mode: 'move' | 'resize', block: LocalBlock, e: React.PointerEvent) => {
    e.stopPropagation()
    pushLocalHistory()

    dragRef.current = {
      mode,
      id: block.id,
      startY: e.clientY,
      origStart: block.startMin,
      origEnd: block.endMin
    }

    const onPointerMove = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const deltaMin = Math.round((ev.clientY - d.startY) / pxPerMin / SNAP_MINUTES) * SNAP_MINUTES

      setBlocks(prev =>
        prev.map(t => {
          if (t.id !== d.id) return t
          if (d.mode === 'move') {
            let ns = Math.max(MIN_START, d.origStart + deltaMin)
            const dur = d.origEnd - d.origStart
            if (ns + dur > MIN_END) ns = MIN_END - dur
            return { ...t, startMin: ns, endMin: ns + dur }
          } else {
            const ne = Math.max(d.origStart + 15, Math.min(MIN_END, d.origEnd + deltaMin))
            return { ...t, endMin: ne }
          }
        })
      )
    }

    const onPointerUp = async () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)

      const d = dragRef.current
      dragRef.current = null
      setDraggingId(null)
      if (!d) return

      setBlocks(currentBlocks => {
        const moved = currentBlocks.find(t => t.id === d.id)
        if (!moved) return currentBlocks

        const delta = d.mode === 'move' ? moved.startMin - d.origStart : moved.endMin - d.origEnd
        if (delta === 0) return currentBlocks

        // Sync to Supabase
        const startIso = new Date(`${day}T${fmt24(moved.startMin)}:00`).toISOString()
        const endIso = new Date(`${day}T${fmt24(moved.endMin)}:00`).toISOString()
        updateItem(moved.id, { start_time: startIso, end_time: endIso }).catch(console.error)

        // Check if pushing into next block
        const sorted = currentBlocks.filter(t => t.type === 'task').sort((a, b) => a.startMin - b.startMin)
        const idx = sorted.findIndex(t => t.id === d.id)
        const chain: string[] = []
        let prevEnd = moved.endMin

        for (let k = idx + 1; k < sorted.length; k++) {
          if (sorted[k].startMin < prevEnd) {
            chain.push(sorted[k].id)
            prevEnd = sorted[k].endMin + delta
          } else break
        }

        if (chain.length > 0) {
          if (cascadeMode === 'never') {
            showToast('Times now overlap')
          } else if (cascadeMode === 'always') {
            applyCascade(chain, delta, currentBlocks)
          } else {
            setCascadePrompt({ chain, delta, count: chain.length })
          }
        }

        return currentBlocks
      })
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    setDraggingId(block.id)
  }

  // Cascade shift execution
  const applyCascade = async (chain: string[], delta: number, currentList = blocks) => {
    const updated = currentList.map(t =>
      chain.includes(t.id) ? { ...t, startMin: t.startMin + delta, endMin: t.endMin + delta } : t
    )
    setBlocks(updated)
    setCascadePrompt(null)
    showToast(`Shifted ${chain.length} item${chain.length > 1 ? 's' : ''}`)

    for (const id of chain) {
      const item = updated.find(t => t.id === id)
      if (item) {
        const startIso = new Date(`${day}T${fmt24(item.startMin)}:00`).toISOString()
        const endIso = new Date(`${day}T${fmt24(item.endMin)}:00`).toISOString()
        updateItem(id, { start_time: startIso, end_time: endIso }).catch(console.error)
      }
    }
  }

  // Update profile settings
  const handleSetCascadeMode = async (mode: 'always' | 'ask' | 'never') => {
    setCascadeMode(mode)
    try {
      await updateProfile({ cascade_preference: mode })
      showToast(`Cascade set to ${mode}`)
    } catch (e) {
      console.error(e)
    }
  }

  const handleSetTimezone = async (tz: string) => {
    setTimezone(tz)
    try {
      await updateProfile({ timezone: tz })
      showToast(`Timezone updated`)
    } catch (e) {
      console.error(e)
    }
  }

  // Hour grid lines (6 AM to 11 PM)
  const hourRows = []
  for (let h = 6; h <= 23; h++) {
    const top = (h * 60 - MIN_START) * pxPerMin
    hourRows.push({ label: fmt12h(h), top, labelTop: top + 4 })
  }

  // Conflict overlap detection
  const tasksOnly = blocks.filter(t => t.type === 'task')
  const conflictIds = new Set<string>()
  const sortedTasks = tasksOnly.slice().sort((a, b) => a.startMin - b.startMin)
  for (let i = 0; i < sortedTasks.length; i++) {
    for (let j = i + 1; j < sortedTasks.length; j++) {
      if (sortedTasks[j].startMin < sortedTasks[i].endMin) {
        conflictIds.add(sortedTasks[i].id)
        conflictIds.add(sortedTasks[j].id)
      }
    }
  }

  // Review panel computations
  const completedCount = tasksOnly.filter(t => t.completed).length
  const notDone = tasksOnly.filter(t => !t.completed).map(t => t.title)
  const conflictPairTitles: string[] = []
  for (let i = 0; i < sortedTasks.length; i++) {
    for (let j = i + 1; j < sortedTasks.length; j++) {
      if (sortedTasks[j].startMin < sortedTasks[i].endMin) {
        conflictPairTitles.push(`${sortedTasks[i].title} and ${sortedTasks[j].title}`)
      }
    }
  }

  let reviewText =
    tasksOnly.length === 0
      ? 'Nothing was scheduled for this day, so there’s nothing to report on. A quiet day counts too.'
      : `You completed ${completedCount} of ${tasksOnly.length} scheduled tasks.`

  if (completedCount > 0) {
    reviewText += ' Good momentum keeping your focus blocks on track.'
  }
  if (conflictPairTitles.length > 0) {
    reviewText += ` Note: ${conflictPairTitles[0]} had overlapping times — worth reviewing if unexpected delay occurred.`
  }
  if (notDone.length > 0) {
    reviewText += ` Remaining open tasks: ${notDone.join(', ')}.`
  }

  // Style helpers
  const pillStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    fontFamily: "'Work Sans', sans-serif",
    fontWeight: 600,
    fontSize: '12px',
    border: 'none',
    borderRadius: '8px',
    padding: '8px 6px',
    cursor: 'pointer',
    backgroundColor: active ? accent : 'transparent',
    color: active ? accentText : 'oklch(0.7 0.006 90)'
  })

  const typePillStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    fontFamily: "'Work Sans', sans-serif",
    fontWeight: 600,
    fontSize: '13px',
    border: `1px solid ${active ? accent : 'oklch(0.32 0.006 90)'}`,
    borderRadius: '9px',
    padding: '9px',
    cursor: 'pointer',
    backgroundColor: active ? `${accent}22` : 'transparent',
    color: active ? accent : 'oklch(0.72 0.006 90)'
  })

  return (
    <div className="w-full h-full flex flex-col bg-[oklch(0.16_0.006_90)] text-[oklch(0.92_0.004_90)] overflow-hidden font-sans select-none">
      {/* =========================================================================
          1. HEADER (EDGE-TO-EDGE, RESPONSIVE)
      ========================================================================== */}
      {/* Mobile Header (< md) */}
      <header className="flex md:hidden w-full items-center justify-between px-3 py-2.5 sm:px-4 border-b border-[oklch(0.24_0.006_90)] bg-[oklch(0.18_0.006_90)] shrink-0 z-30">
        <span className="font-bold text-[16px] tracking-tight text-[oklch(0.94_0.004_90)]">
          Daylog
        </span>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => changeDate(-1)}
            className="w-7 h-7 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center cursor-pointer"
          >
            ‹
          </button>
          <div className="text-center min-w-[96px]">
            <div className="font-semibold text-[13px] text-[oklch(0.92_0.004_90)]">{dateLabel}</div>
            {isToday && (
              <div className="font-mono text-[10px] text-[#d9a441] leading-none">
                now {format(now, 'HH:mm')}
              </div>
            )}
          </div>
          <button
            onClick={() => changeDate(1)}
            className="w-7 h-7 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center cursor-pointer"
          >
            ›
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setPanel('review')}
            className="w-8 h-8 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center cursor-pointer"
            title="Day Review"
          >
            ☰
          </button>
          <button
            onClick={() => setPanel('settings')}
            className="w-8 h-8 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center cursor-pointer"
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {/* Desktop Header (>= md) */}
      <header className="hidden md:flex w-full items-center justify-between px-8 py-4 border-b border-[oklch(0.24_0.006_90)] bg-[oklch(0.18_0.006_90)] shrink-0 z-30">
        <div className="flex items-center gap-3">
          <span className="font-bold text-xl tracking-tight text-[oklch(0.94_0.004_90)]">
            Daylog
          </span>
        </div>

        {/* Center: Date Navigation */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => changeDate(-1)}
            className="w-8 h-8 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-base flex items-center justify-center hover:bg-[oklch(0.24_0.006_90)] cursor-pointer transition-colors"
          >
            ‹
          </button>
          <div className="text-center min-w-[170px]">
            <div className="font-semibold text-[15px] text-[oklch(0.94_0.004_90)]">{dateLabel}</div>
            <div className="font-mono text-[11px] text-[#d9a441] tracking-wide">
              {isToday ? 'now ' + format(now, 'HH:mm') : ''}
            </div>
          </div>
          <button
            onClick={() => changeDate(1)}
            className="w-8 h-8 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-base flex items-center justify-center hover:bg-[oklch(0.24_0.006_90)] cursor-pointer transition-colors"
          >
            ›
          </button>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-3">
          <button
            onClick={handleUndo}
            title="Undo (Ctrl+Z)"
            style={{
              fontFamily: "'Work Sans', sans-serif",
              fontWeight: 600,
              fontSize: '13px',
              border: '1px solid oklch(0.3 0.006 90)',
              borderRadius: '9px',
              padding: '8px 14px',
              cursor: historyStack.length ? 'pointer' : 'default',
              background: 'oklch(0.2 0.006 90)',
              color: historyStack.length ? 'oklch(0.78 0.006 90)' : 'oklch(0.4 0.006 90)',
              opacity: historyStack.length ? 1 : 0.5
            }}
          >
            Undo
          </button>

          <button
            onClick={openAdd}
            style={{
              fontFamily: "'Work Sans', sans-serif",
              fontWeight: 600,
              fontSize: '13px',
              border: 'none',
              borderRadius: '9px',
              padding: '8px 16px',
              cursor: 'pointer',
              background: accent,
              color: accentText
            }}
          >
            + Add block
          </button>

          <button
            onClick={() => setPanel('review')}
            className="w-9 h-9 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center hover:bg-[oklch(0.24_0.006_90)] cursor-pointer transition-colors"
            title="Day Review"
          >
            ☰
          </button>

          <button
            onClick={() => setPanel('settings')}
            className="w-9 h-9 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center hover:bg-[oklch(0.24_0.006_90)] cursor-pointer transition-colors"
            title="Settings"
          >
            ⚙
          </button>

          <form action="/auth/signout" method="post" className="m-0">
            <button
              type="submit"
              className="font-sans text-xs text-[oklch(0.58_0.006_90)] hover:text-[oklch(0.9_0.004_90)] bg-transparent border-none cursor-pointer py-1.5 px-2 transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>

      {/* =========================================================================
          2. TIMELINE VIEWPORT (FULL-BLEED EDGE-TO-EDGE)
      ========================================================================== */}
      <main className="flex-1 w-full overflow-y-auto relative min-h-0 bg-[oklch(0.16_0.006_90)]">
        {/* Empty Day State */}
        {blocks.length === 0 ? (
          <div className="h-full min-h-[380px] w-full flex flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="hatch w-16 h-16 rounded-2xl border border-[oklch(0.3_0.006_90)] shadow-md" />
            <div className="max-w-[280px]">
              <div className="font-semibold text-lg text-[oklch(0.94_0.004_90)] mb-1.5">
                This day is a blank page
              </div>
              <div className="text-sm text-[oklch(0.6_0.006_90)] leading-relaxed">
                Nothing is scheduled yet. Lay down your first block whenever you're ready.
              </div>
            </div>
            <button
              onClick={openAdd}
              style={{
                fontFamily: "'Work Sans', sans-serif",
                fontWeight: 600,
                fontSize: '13.5px',
                border: 'none',
                borderRadius: '10px',
                padding: '10px 22px',
                cursor: 'pointer',
                background: accent,
                color: accentText
              }}
            >
              Add the first block
            </button>
          </div>
        ) : (
          /* Non-Empty Timeline Track */
          <div
            ref={trackRef}
            className="w-full relative py-4"
            style={{
              height: `${(MIN_END - MIN_START) * pxPerMin + 40}px`
            }}
          >
            {/* Hour Grid Lines across full width */}
            {hourRows.map(row => (
              <React.Fragment key={row.label}>
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    top: `${row.top}px`,
                    height: '1px',
                    background: 'oklch(0.24 0.006 90)'
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: isMobile ? '8px' : '14px',
                    top: `${row.labelTop}px`,
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: isMobile ? '10.5px' : '11px',
                    color: 'oklch(0.5 0.006 90)',
                    letterSpacing: '0.02em',
                    userSelect: 'none'
                  }}
                >
                  {row.label}
                </div>
              </React.Fragment>
            ))}

            {/* Current Time (Now) Line */}
            {isToday && nowMinutes >= MIN_START && nowMinutes <= MIN_END && (
              <div
                style={{
                  position: 'absolute',
                  left: `${gutterWidth}px`,
                  right: `${blockRight}px`,
                  top: `${nowTop}px`,
                  height: '2px',
                  background: accent,
                  zIndex: 10,
                  boxShadow: `0 0 8px ${accent}99`
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: '-5px',
                    top: '-4px',
                    width: '10px',
                    height: '10px',
                    borderRadius: '50%',
                    background: accent
                  }}
                />
              </div>
            )}

            {/* Blocks spanning from gutter to device edge */}
            {blocks.map(b => {
              const top = (b.startMin - MIN_START) * pxPerMin
              const height = Math.max(8, (b.endMin - b.startMin) * pxPerMin)
              const timeLabel = `${fmt24(b.startMin)}–${fmt24(b.endMin)}`

              if (b.type === 'buffer') {
                return (
                  <div
                    key={b.id}
                    className="hatch"
                    onClick={() => setSelectedBlockId(selectedBlockId === b.id ? null : b.id)}
                    style={{
                      position: 'absolute',
                      left: `${gutterWidth}px`,
                      right: `${blockRight}px`,
                      top: `${top}px`,
                      height: `${height}px`,
                      borderRadius: '9px',
                      border: '1px solid oklch(0.28 0.006 90)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      overflow: 'hidden',
                      cursor: 'pointer'
                    }}
                  >
                    {height > 24 && (
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: '10.5px',
                          color: 'oklch(0.6 0.006 90)',
                          letterSpacing: '0.03em'
                        }}
                      >
                        buffer · {timeLabel}
                      </span>
                    )}

                    {selectedBlockId === b.id && (
                      <div style={{ position: 'absolute', right: '8px', top: '6px', display: 'flex', gap: '5px' }}>
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            openEdit(b)
                          }}
                          style={{
                            fontFamily: "'Work Sans', sans-serif",
                            fontSize: '10.5px',
                            fontWeight: 600,
                            border: '1px solid oklch(0.34 0.006 90)',
                            background: 'oklch(0.24 0.006 90)',
                            color: 'oklch(0.78 0.006 90)',
                            borderRadius: '6px',
                            padding: '3px 7px',
                            cursor: 'pointer'
                          }}
                        >
                          Edit
                        </button>
                        <button
                          onClick={e => {
                            e.stopPropagation()
                            handleDeleteBlock(b.id)
                          }}
                          style={{
                            fontFamily: "'Work Sans', sans-serif",
                            fontSize: '12px',
                            fontWeight: 600,
                            border: '1px solid oklch(0.34 0.006 90)',
                            background: 'oklch(0.24 0.006 90)',
                            color: 'oklch(0.78 0.006 90)',
                            borderRadius: '6px',
                            width: '20px',
                            height: '20px',
                            cursor: 'pointer',
                            lineHeight: 1
                          }}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </div>
                )
              }

              // Task Block
              const dragging = draggingId === b.id
              const conflict = conflictIds.has(b.id)
              const selected = selectedBlockId === b.id
              const baseBorder = conflict ? 'oklch(0.62 0.2 25)' : 'oklch(0.3 0.006 90)'

              return (
                <div
                  key={b.id}
                  onClick={() => setSelectedBlockId(selected ? null : b.id)}
                  style={{
                    position: 'absolute',
                    left: `${gutterWidth}px`,
                    right: `${blockRight}px`,
                    top: `${top}px`,
                    height: `${height}px`,
                    borderRadius: '11px',
                    background: dragging ? 'oklch(0.27 0.006 90)' : 'oklch(0.2 0.006 90)',
                    border: `1.5px solid ${baseBorder}`,
                    cursor: 'default',
                    transition: dragging ? 'none' : 'background 0.15s',
                    boxShadow: dragging ? '0 18px 30px -10px rgba(0,0,0,0.55)' : 'none',
                    opacity: dragging ? 0.88 : b.completed ? 0.55 : 1,
                    zIndex: dragging ? 20 : selected ? 12 : 3
                  }}
                >
                  {/* Grip Handle */}
                  <div
                    onPointerDown={e => startDrag('move', b, e)}
                    style={{
                      position: 'absolute',
                      left: '6px',
                      top: 0,
                      bottom: 0,
                      width: '16px',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '3px',
                      cursor: 'grab',
                      touchAction: 'none'
                    }}
                    title="Drag to move"
                  >
                    <div style={{ width: '10px', height: '2px', borderRadius: '1px', background: 'oklch(0.42 0.006 90)' }} />
                    <div style={{ width: '10px', height: '2px', borderRadius: '1px', background: 'oklch(0.42 0.006 90)' }} />
                    <div style={{ width: '10px', height: '2px', borderRadius: '1px', background: 'oklch(0.42 0.006 90)' }} />
                  </div>

                  {/* Block Content */}
                  <div
                    style={{
                      position: 'absolute',
                      left: '26px',
                      right: '8px',
                      top: 0,
                      bottom: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      gap: '2px',
                      padding: '4px 0',
                      overflow: 'hidden'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          toggleComplete(b.id)
                        }}
                        style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '6px',
                          border: `1.5px solid ${b.completed ? accent : 'oklch(0.45 0.006 90)'}`,
                          background: b.completed ? accent : 'transparent',
                          color: accentText,
                          fontSize: '11px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          padding: 0,
                          flexShrink: 0
                        }}
                      >
                        {b.completed ? '✓' : ''}
                      </button>
                      <span
                        style={{
                          fontFamily: "'Work Sans', sans-serif",
                          fontSize: isMobile ? '13px' : '14px',
                          fontWeight: 500,
                          color: b.completed ? 'oklch(0.5 0.006 90)' : 'oklch(0.94 0.004 90)',
                          textDecoration: b.completed ? 'line-through' : 'none',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}
                      >
                        {b.title}
                      </span>
                    </div>
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '10.5px',
                        letterSpacing: '0.02em',
                        color: 'oklch(0.56 0.006 90)',
                        paddingLeft: '26px'
                      }}
                    >
                      {timeLabel}
                    </span>
                  </div>

                  {/* Conflict dot */}
                  {conflict && (
                    <div
                      style={{
                        position: 'absolute',
                        right: '8px',
                        top: '6px',
                        width: '8px',
                        height: '8px',
                        borderRadius: '50%',
                        background: 'oklch(0.62 0.2 25)',
                        boxShadow: '0 0 0 3px oklch(0.62 0.2 25 / 0.22)'
                      }}
                      title="Conflict overlap detected"
                    />
                  )}

                  {/* Actions (visible if selected or on hover) */}
                  <div
                    style={{
                      position: 'absolute',
                      right: '8px',
                      top: '6px',
                      display: 'flex',
                      gap: '5px',
                      opacity: selected ? 1 : 0,
                      transition: 'opacity 0.12s'
                    }}
                    className="group-hover:opacity-100"
                  >
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        openEdit(b)
                      }}
                      style={{
                        fontFamily: "'Work Sans', sans-serif",
                        fontSize: '10.5px',
                        fontWeight: 600,
                        border: '1px solid oklch(0.34 0.006 90)',
                        background: 'oklch(0.24 0.006 90)',
                        color: 'oklch(0.78 0.006 90)',
                        borderRadius: '6px',
                        padding: '3px 7px',
                        cursor: 'pointer'
                      }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={e => {
                        e.stopPropagation()
                        handleDeleteBlock(b.id)
                      }}
                      style={{
                        fontFamily: "'Work Sans', sans-serif",
                        fontSize: '12px',
                        fontWeight: 600,
                        border: '1px solid oklch(0.34 0.006 90)',
                        background: 'oklch(0.24 0.006 90)',
                        color: 'oklch(0.78 0.006 90)',
                        borderRadius: '6px',
                        width: '20px',
                        height: '20px',
                        cursor: 'pointer',
                        lineHeight: 1
                      }}
                    >
                      ×
                    </button>
                  </div>

                  {/* Resize Handle at Bottom */}
                  <div
                    onPointerDown={e => startDrag('resize', b, e)}
                    style={{
                      position: 'absolute',
                      left: '50%',
                      bottom: '2px',
                      transform: 'translateX(-50%)',
                      width: '30px',
                      height: '4px',
                      borderRadius: '2px',
                      background: 'oklch(0.4 0.006 90)',
                      cursor: 'ns-resize',
                      touchAction: 'none'
                    }}
                    title="Drag to resize"
                  />
                </div>
              )
            })}
          </div>
        )}

        {/* Desktop Floating Action Button (+ FAB) */}
        {!isMobile && blocks.length > 0 && (
          <button
            onClick={openAdd}
            className="fixed right-8 bottom-8 w-13 h-13 rounded-2xl flex items-center justify-center font-bold text-2xl shadow-2xl cursor-pointer hover:scale-105 active:scale-95 transition-all z-40"
            style={{
              backgroundColor: accent,
              color: accentText,
              boxShadow: `0 12px 28px -6px ${accent}88`
            }}
            title="Add block"
          >
            +
          </button>
        )}
      </main>

      {/* =========================================================================
          3. MOBILE BOTTOM TOOLBAR (FULL-WIDTH EDGE-TO-EDGE)
      ========================================================================== */}
      <nav className="flex md:hidden w-full items-stretch border-t border-[oklch(0.24_0.006_90)] bg-[oklch(0.18_0.006_90)] px-2 py-1.5 pb-[calc(6px+env(safe-area-inset-bottom,0px))] gap-1 shrink-0 z-30">
        <button
          onClick={goToday}
          className="flex-1 flex flex-col items-center gap-0.5 bg-transparent border-none text-[10.5px] font-semibold py-1 cursor-pointer"
          style={{ color: isToday ? accent : 'oklch(0.68 0.006 90)' }}
        >
          <span className="text-[16px] leading-tight">◎</span>
          Today
        </button>

        <button
          onClick={handleUndo}
          className="flex-1 flex flex-col items-center gap-0.5 bg-transparent border-none text-[10.5px] font-semibold py-1 cursor-pointer"
          style={{
            color: 'oklch(0.68 0.006 90)',
            opacity: historyStack.length ? 1 : 0.4,
            pointerEvents: historyStack.length ? 'auto' : 'none'
          }}
        >
          <span className="text-[16px] leading-tight">↺</span>
          Undo
        </button>

        <button
          onClick={openAdd}
          className="flex-[1.3] flex flex-col items-center justify-center gap-0.5 border-none font-bold text-[11px] py-1 mx-0.5 rounded-xl cursor-pointer shadow-md"
          style={{ backgroundColor: accent, color: accentText }}
        >
          <span className="text-[18px] leading-none font-bold">+</span>
          Add
        </button>

        <button
          onClick={() => setPanel('settings')}
          className="flex-1 flex flex-col items-center gap-0.5 bg-transparent border-none text-[10.5px] font-semibold py-1 cursor-pointer text-[oklch(0.68_0.006_90)]"
        >
          <span className="text-[16px] leading-tight">⚙</span>
          Settings
        </button>

        <button
          onClick={() => setPanel('review')}
          className="flex-1 flex flex-col items-center gap-0.5 bg-transparent border-none text-[10.5px] font-semibold py-1 cursor-pointer text-[oklch(0.68_0.006_90)]"
        >
          <span className="text-[16px] leading-tight">☰</span>
          Review
        </button>
      </nav>

      {/* =========================================================================
          4. MODAL: ADD / EDIT BLOCK (RESPONSIVE: SHEET ON MOBILE, CARD ON DESKTOP)
      ========================================================================== */}
      {modal && (
        <div
          onClick={() => setModal(null)}
          className="fixed inset-0 bg-black/60 z-50 flex items-end md:items-center justify-center animate-fadeIn"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full md:w-[440px] max-h-[90dvh] overflow-y-auto bg-[oklch(0.19_0.006_90)] border-t md:border border-[oklch(0.28_0.006_90)] rounded-t-3xl md:rounded-2xl p-6 pb-[calc(20px+env(safe-area-inset-bottom,0px))] shadow-2xl animate-sheetUp md:animate-none"
          >
            <div className="flex items-center justify-between mb-4">
              <span className="font-semibold text-lg text-[oklch(0.94_0.004_90)]">
                {modal.mode === 'add' ? 'Add block' : 'Edit block'}
              </span>
              <button
                onClick={() => setModal(null)}
                className="w-7 h-7 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.22_0.006_90)] text-[oklch(0.7_0.006_90)] cursor-pointer text-base flex items-center justify-center"
              >
                ×
              </button>
            </div>

            {/* Type selector */}
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                onClick={() => setModal({ ...modal, draft: { ...modal.draft, type: 'task' } })}
                style={typePillStyle(modal.draft.type === 'task')}
              >
                Task
              </button>
              <button
                type="button"
                onClick={() => setModal({ ...modal, draft: { ...modal.draft, type: 'buffer' } })}
                style={typePillStyle(modal.draft.type === 'buffer')}
              >
                Buffer
              </button>
            </div>

            {/* Title field */}
            <label className="block text-xs font-medium text-[oklch(0.6_0.006_90)] mb-1.5">
              {modal.draft.type === 'buffer' ? 'Label (optional)' : 'Title'}
            </label>
            <input
              type="text"
              value={modal.draft.title}
              onChange={e => setModal({ ...modal, draft: { ...modal.draft, title: e.target.value } })}
              placeholder={modal.draft.type === 'buffer' ? 'e.g. Transition' : 'e.g. Deep work block'}
              className="w-full text-sm bg-[oklch(0.21_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl p-3 text-[oklch(0.92_0.004_90)] mb-4 outline-none focus:border-[#d9a441] transition-colors"
            />

            {/* Time inputs */}
            <div className="flex gap-3 mb-6">
              <div className="flex-1">
                <label className="block text-xs font-medium text-[oklch(0.6_0.006_90)] mb-1.5">
                  Start
                </label>
                <input
                  type="time"
                  value={modal.draft.startStr}
                  onChange={e => setModal({ ...modal, draft: { ...modal.draft, startStr: e.target.value } })}
                  className="w-full font-mono text-sm bg-[oklch(0.21_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl p-2.5 text-[oklch(0.92_0.004_90)] outline-none"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs font-medium text-[oklch(0.6_0.006_90)] mb-1.5">
                  End
                </label>
                <input
                  type="time"
                  value={modal.draft.endStr}
                  onChange={e => setModal({ ...modal, draft: { ...modal.draft, endStr: e.target.value } })}
                  className="w-full font-mono text-sm bg-[oklch(0.21_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl p-2.5 text-[oklch(0.92_0.004_90)] outline-none"
                />
              </div>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2.5 items-center">
              {modal.mode === 'edit' && modal.id && (
                <button
                  type="button"
                  onClick={() => handleDeleteBlock(modal.id!)}
                  className="text-sm font-semibold border border-[oklch(0.35_0.02_25)] bg-[oklch(0.22_0.02_25)] text-[oklch(0.75_0.14_25)] rounded-xl py-3 px-4 cursor-pointer hover:bg-[oklch(0.26_0.02_25)] transition-colors"
                >
                  Delete
                </button>
              )}
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setModal(null)}
                className="text-sm font-semibold border border-[oklch(0.32_0.006_90)] bg-transparent text-[oklch(0.72_0.006_90)] rounded-xl py-3 px-5 cursor-pointer hover:bg-[oklch(0.23_0.006_90)] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveDraft}
                style={{ backgroundColor: accent, color: accentText }}
                className="text-sm font-bold border-none rounded-xl py-3 px-6 cursor-pointer shadow-md hover:brightness-105 active:scale-95 transition-all"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          5. PANELS: SETTINGS & DAY REVIEW (RESPONSIVE: SHEET ON MOBILE, DRAWER ON DESKTOP)
      ========================================================================== */}
      {panel && (
        <div
          onClick={() => setPanel(null)}
          className="fixed inset-0 bg-black/50 z-50 flex items-end md:items-stretch justify-end animate-fadeIn"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full md:w-[380px] max-h-[90dvh] md:max-h-none md:h-full overflow-y-auto bg-[oklch(0.18_0.006_90)] border-t md:border-t-0 md:border-l border-[oklch(0.28_0.006_90)] rounded-t-3xl md:rounded-none p-6 pb-[calc(20px+env(safe-area-inset-bottom,0px))] shadow-2xl animate-sheetUp md:animate-none"
          >
            <div className="flex items-center justify-between mb-5">
              <span className="font-semibold text-lg text-[oklch(0.94_0.004_90)]">
                {panel === 'settings' ? 'Settings' : 'Day Review'}
              </span>
              <button
                onClick={() => setPanel(null)}
                className="w-7 h-7 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.22_0.006_90)] text-[oklch(0.7_0.006_90)] cursor-pointer text-base flex items-center justify-center"
              >
                ×
              </button>
            </div>

            {/* Settings content */}
            {panel === 'settings' && (
              <div>
                <div className="mb-5">
                  <label className="block text-xs font-medium text-[oklch(0.6_0.006_90)] mb-2">
                    Timezone
                  </label>
                  <select
                    value={timezone}
                    onChange={e => handleSetTimezone(e.target.value)}
                    className="w-full text-sm bg-[oklch(0.21_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl p-3 text-[oklch(0.92_0.004_90)] outline-none"
                  >
                    <option value="America/Los_Angeles">Pacific Time (Los Angeles)</option>
                    <option value="America/New_York">Eastern Time (New York)</option>
                    <option value="Europe/London">London (GMT)</option>
                    <option value="Asia/Kolkata">India (IST)</option>
                    <option value="Asia/Tokyo">Tokyo (JST)</option>
                    <option value="UTC">UTC</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[oklch(0.6_0.006_90)] mb-2">
                    Cascade behavior
                  </label>
                  <div className="text-xs text-[oklch(0.55_0.006_90)] mb-3 leading-relaxed">
                    When moving a block pushes it into the next one, should Daylog offer to shift the rest of your day too?
                  </div>
                  <div className="flex bg-[oklch(0.21_0.006_90)] border border-[oklch(0.3_0.006_90)] rounded-xl p-1 gap-1">
                    <button
                      type="button"
                      onClick={() => handleSetCascadeMode('always')}
                      style={pillStyle(cascadeMode === 'always')}
                    >
                      Always
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetCascadeMode('ask')}
                      style={pillStyle(cascadeMode === 'ask')}
                    >
                      Ask
                    </button>
                    <button
                      type="button"
                      onClick={() => handleSetCascadeMode('never')}
                      style={pillStyle(cascadeMode === 'never')}
                    >
                      Never
                    </button>
                  </div>
                </div>

                <div className="mt-8 pt-4 border-t border-[oklch(0.26_0.006_90)]">
                  <form action="/auth/signout" method="post">
                    <button
                      type="submit"
                      className="w-full text-sm font-semibold py-3 px-4 rounded-xl border border-[oklch(0.32_0.006_90)] bg-[oklch(0.22_0.006_90)] text-[oklch(0.8_0.006_90)] cursor-pointer hover:bg-[oklch(0.26_0.006_90)] transition-colors"
                    >
                      Sign out
                    </button>
                  </form>
                </div>
              </div>
            )}

            {/* Day Review content */}
            {panel === 'review' && (
              <div className="bg-[oklch(0.21_0.006_90)] border border-[oklch(0.3_0.006_90)] rounded-2xl p-5 shadow-sm">
                <div className="flex items-baseline gap-2 mb-3">
                  <span className="font-mono text-3xl font-bold" style={{ color: accent }}>
                    {completedCount}
                  </span>
                  <span className="text-sm text-[oklch(0.6_0.006_90)]">
                    of {tasksOnly.length} tasks completed
                  </span>
                </div>
                <p className="text-sm leading-relaxed text-[oklch(0.84_0.004_90)] m-0">
                  {reviewText}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          6. CASCADE PROMPT POPOVER
      ========================================================================== */}
      {cascadePrompt && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-20 md:bottom-8 z-50 w-[min(340px,92%)] bg-[oklch(0.24_0.008_70)] border border-[oklch(0.4_0.03_70)] rounded-2xl p-4 shadow-2xl animate-fadeIn">
          <div className="text-sm text-[oklch(0.94_0.006_90)] mb-3 leading-snug">
            Shift {cascadePrompt.count} following item{cascadePrompt.count > 1 ? 's' : ''} by {Math.abs(cascadePrompt.delta)} min?
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => setCascadePrompt(null)}
              className="flex-1 text-xs font-semibold border border-[oklch(0.4_0.01_90)] bg-transparent text-[oklch(0.85_0.006_90)] rounded-lg py-2 px-2.5 cursor-pointer hover:bg-[oklch(0.28_0.01_90)] transition-colors"
            >
              Don't cascade
            </button>
            <button
              onClick={() => applyCascade(cascadePrompt.chain, cascadePrompt.delta)}
              style={{ backgroundColor: accent, color: accentText }}
              className="flex-1 text-xs font-bold border-none rounded-lg py-2 px-2.5 cursor-pointer shadow-md hover:brightness-105 active:scale-95 transition-all"
            >
              Cascade
            </button>
          </div>
        </div>
      )}

      {/* =========================================================================
          7. FLOATING TOAST NOTIFICATION
      ========================================================================== */}
      {toast && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-20 md:bottom-8 z-50 flex items-center gap-3 bg-[oklch(0.23_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl py-2.5 px-4 shadow-2xl animate-toastIn">
          <span className="text-sm text-[oklch(0.88_0.004_90)]">{toast.msg}</span>
          <button
            onClick={handleUndo}
            style={{ color: accent }}
            className="text-xs font-bold border-none bg-transparent cursor-pointer py-1 px-1.5 hover:underline"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
