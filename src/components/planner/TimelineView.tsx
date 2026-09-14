'use client'

import React, { useState, useEffect, useRef } from 'react'
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

  // Viewport mode: 'desktop' or 'mobile'
  const [viewportMode, setViewportMode] = useState<'desktop' | 'mobile'>('desktop')
  const [isScreenMobile, setIsScreenMobile] = useState(false)

  // Local state
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

  // Accent color
  const accent = '#d9a441'
  const accentText = 'oklch(0.18 0.01 90)'

  // Check screen width for auto mobile adaptation
  useEffect(() => {
    const checkWidth = () => {
      const isMobileWidth = window.innerWidth < 768
      setIsScreenMobile(isMobileWidth)
    }
    checkWidth()
    window.addEventListener('resize', checkWidth)
    return () => window.removeEventListener('resize', checkWidth)
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

  // Pixels per minute based on mode
  const activeIsMobile = isScreenMobile || viewportMode === 'mobile'
  const pxPerMin = (activeIsMobile ? 72 : 96) / 60
  const gutterWidth = activeIsMobile ? 52 : 64

  // Date helpers
  const targetDate = parseISO(day)
  const isToday = isSameDay(targetDate, now)
  const nowMinutes = differenceInMinutes(now, startOfDay(now))
  const nowTop = (nowMinutes - MIN_START) * pxPerMin
  const dateLabel = format(targetDate, 'EEE, MMM d')

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

      // Find moved block in latest state
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

    // Update in Supabase
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
    <div className="w-full flex-1 flex flex-col items-center p-4 sm:p-7 pb-16 font-sans">
      {/* Top Preview Switcher */}
      <div className="w-full max-w-[1280px] flex justify-end mb-4">
        <div className="flex items-center gap-2.5 bg-[oklch(0.19_0.006_90)] border border-[oklch(0.28_0.006_90)] rounded-xl p-1 shadow-md">
          <span className="text-[11px] font-medium tracking-wide text-[oklch(0.55_0.006_90)] px-2">
            View Mode
          </span>
          <button
            onClick={() => setViewportMode('desktop')}
            className="border-0 cursor-pointer font-sans text-[13px] font-semibold py-1.5 px-3.5 rounded-lg transition-all"
            style={{
              backgroundColor: viewportMode === 'desktop' ? accent : 'transparent',
              color: viewportMode === 'desktop' ? accentText : 'oklch(0.72 0.006 90)'
            }}
          >
            Desktop
          </button>
          <button
            onClick={() => setViewportMode('mobile')}
            className="border-0 cursor-pointer font-sans text-[13px] font-semibold py-1.5 px-3.5 rounded-lg transition-all"
            style={{
              backgroundColor: viewportMode === 'mobile' ? accent : 'transparent',
              color: viewportMode === 'mobile' ? accentText : 'oklch(0.72 0.006 90)'
            }}
          >
            Mobile
          </button>
        </div>
      </div>

      {/* Main Container: Dual Frame (Desktop wide box or Mobile phone frame) */}
      <div
        className="transition-all duration-300 relative flex flex-col bg-[oklch(0.16_0.006_90)] text-[oklch(0.92_0.004_90)] overflow-hidden"
        style={
          viewportMode === 'mobile'
            ? {
                width: '390px',
                height: '844px',
                borderRadius: '44px',
                border: '1px solid oklch(0.3 0.006 90)',
                boxShadow: '0 30px 80px -20px rgba(0,0,0,0.65)'
              }
            : {
                width: '100%',
                maxWidth: '1280px',
                height: '820px',
                borderRadius: '16px',
                border: '1px solid oklch(0.26 0.006 90)',
                boxShadow: '0 30px 80px -24px rgba(0,0,0,0.55)'
              }
        }
      >
        {/* HEADER */}
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: activeIsMobile ? '16px 16px 12px' : '20px 26px 16px',
            borderBottom: '1px solid oklch(0.24 0.006 90)',
            flexShrink: 0
          }}
        >
          {/* Logo / Wordmark */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span
              style={{
                fontFamily: "'Work Sans', sans-serif",
                fontWeight: 700,
                fontSize: activeIsMobile ? '16px' : '18px',
                letterSpacing: '-0.01em',
                color: 'oklch(0.92 0.004 90)'
              }}
            >
              Daylog
            </span>
          </div>

          {/* Date Controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={() => changeDate(-1)}
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '8px',
                border: '1px solid oklch(0.3 0.006 90)',
                background: 'oklch(0.2 0.006 90)',
                color: 'oklch(0.72 0.006 90)',
                fontSize: '15px',
                cursor: 'pointer'
              }}
            >
              ‹
            </button>
            <div style={{ textAlign: 'center', minWidth: '118px' }}>
              <div
                style={{
                  fontFamily: "'Work Sans', sans-serif",
                  fontWeight: 600,
                  fontSize: activeIsMobile ? '13.5px' : '14.5px'
                }}
              >
                {dateLabel}
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '10.5px',
                  color: isToday ? accent : 'oklch(0.58 0.006 90)',
                  letterSpacing: '0.02em'
                }}
              >
                {isToday ? 'now ' + format(now, 'HH:mm') : ''}
              </div>
            </div>
            <button
              onClick={() => changeDate(1)}
              style={{
                width: '30px',
                height: '30px',
                borderRadius: '8px',
                border: '1px solid oklch(0.3 0.006 90)',
                background: 'oklch(0.2 0.006 90)',
                color: 'oklch(0.72 0.006 90)',
                fontSize: '15px',
                cursor: 'pointer'
              }}
            >
              ›
            </button>
          </div>

          {/* Action Buttons */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {!activeIsMobile && (
              <>
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
              </>
            )}

            <button
              onClick={() => setPanel('review')}
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '9px',
                border: '1px solid oklch(0.3 0.006 90)',
                background: 'oklch(0.2 0.006 90)',
                color: 'oklch(0.72 0.006 90)',
                fontSize: '14px',
                cursor: 'pointer'
              }}
              title="Day Review"
            >
              ☰
            </button>
            <button
              onClick={() => setPanel('settings')}
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '9px',
                border: '1px solid oklch(0.3 0.006 90)',
                background: 'oklch(0.2 0.006 90)',
                color: 'oklch(0.72 0.006 90)',
                fontSize: '14px',
                cursor: 'pointer'
              }}
              title="Settings"
            >
              ⚙
            </button>

            {!activeIsMobile && (
              <form action="/auth/signout" method="post" style={{ margin: 0 }}>
                <button
                  type="submit"
                  style={{
                    fontFamily: "'Work Sans', sans-serif",
                    fontSize: '12px',
                    color: 'oklch(0.58 0.006 90)',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '6px 8px'
                  }}
                >
                  Sign out
                </button>
              </form>
            )}
          </div>
        </header>

        {/* TIMELINE VIEWPORT */}
        <div style={{ flex: 1, overflowY: 'auto', position: 'relative', minHeight: 0 }}>
          {/* Empty Day State */}
          {blocks.length === 0 ? (
            <div
              style={{
                height: '100%',
                minHeight: '420px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '18px',
                padding: '40px',
                textAlign: 'center'
              }}
            >
              <div
                className="hatch"
                style={{
                  width: '64px',
                  height: '64px',
                  borderRadius: '16px',
                  border: '1px solid oklch(0.3 0.006 90)'
                }}
              />
              <div style={{ maxWidth: '280px' }}>
                <div
                  style={{
                    fontFamily: "'Work Sans', sans-serif",
                    fontWeight: 600,
                    fontSize: '17px',
                    marginBottom: '6px'
                  }}
                >
                  This day is a blank page
                </div>
                <div
                  style={{
                    fontFamily: "'Work Sans', sans-serif",
                    fontSize: '13.5px',
                    color: 'oklch(0.6 0.006 90)',
                    lineHeight: 1.5
                  }}
                >
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
                  padding: '10px 20px',
                  cursor: 'pointer',
                  background: accent,
                  color: accentText
                }}
              >
                Add the first block
              </button>
            </div>
          ) : (
            /* Non-empty Day Timeline Track */
            <div
              ref={trackRef}
              style={{
                position: 'relative',
                height: `${(MIN_END - MIN_START) * pxPerMin + 30}px`,
                padding: `${activeIsMobile ? '16px 10px' : '20px 20px'} 20px`
              }}
            >
              {/* Hour Grid Lines */}
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
                      left: `${activeIsMobile ? 12 : 20}px`,
                      top: `${row.labelTop}px`,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '11px',
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
                    right: '10px',
                    top: `${nowTop}px`,
                    height: '2px',
                    background: accent,
                    zIndex: 5,
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

              {/* Blocks */}
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
                        right: '10px',
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
                      {height > 26 && (
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

                      {/* Floating actions if selected */}
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

                // Standard Task Block
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
                      right: '10px',
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
                    {/* Grab Handle */}
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

                    {/* Content */}
                    <div
                      style={{
                        position: 'absolute',
                        left: '28px',
                        right: '10px',
                        top: 0,
                        bottom: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center',
                        gap: '2px',
                        padding: '6px 0',
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
                            fontSize: activeIsMobile ? '13.5px' : '14px',
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

                    {/* Conflict dot indicator */}
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

                    {/* Action buttons (visible if selected or on hover) */}
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

                    {/* Resize handle at bottom */}
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

          {/* Desktop Floating Action Button (FAB) */}
          {!activeIsMobile && blocks.length > 0 && (
            <button
              onClick={openAdd}
              style={{
                position: 'absolute',
                right: '24px',
                bottom: '24px',
                width: '52px',
                height: '52px',
                borderRadius: '16px',
                border: 'none',
                background: accent,
                color: accentText,
                fontSize: '24px',
                fontWeight: 600,
                cursor: 'pointer',
                boxShadow: `0 12px 24px -8px ${accent}88`,
                zIndex: 40
              }}
              title="Add block"
            >
              +
            </button>
          )}
        </div>

        {/* MOBILE BOTTOM NAVIGATION BAR */}
        {activeIsMobile && (
          <nav
            style={{
              display: 'flex',
              alignItems: 'stretch',
              borderTop: '1px solid oklch(0.26 0.006 90)',
              background: 'oklch(0.19 0.006 90)',
              padding: '8px 6px calc(8px + env(safe-area-inset-bottom,0px))',
              gap: '4px',
              flexShrink: 0
            }}
          >
            <button
              onClick={goToday}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '3px',
                background: 'none',
                border: 'none',
                color: isToday ? accent : 'oklch(0.68 0.006 90)',
                fontFamily: "'Work Sans', sans-serif",
                fontSize: '10.5px',
                fontWeight: 600,
                padding: '6px 2px',
                cursor: 'pointer'
              }}
            >
              <span style={{ fontSize: '16px' }}>◎</span>Today
            </button>

            <button
              onClick={handleUndo}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '3px',
                background: 'none',
                border: 'none',
                color: 'oklch(0.68 0.006 90)',
                fontFamily: "'Work Sans', sans-serif",
                fontSize: '10.5px',
                fontWeight: 600,
                padding: '6px 2px',
                cursor: 'pointer',
                opacity: historyStack.length ? 1 : 0.4,
                pointerEvents: historyStack.length ? 'auto' : 'none'
              }}
            >
              <span style={{ fontSize: '16px' }}>↺</span>Undo
            </button>

            <button
              onClick={openAdd}
              style={{
                flex: 1.3,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '3px',
                border: 'none',
                color: accentText,
                fontFamily: "'Work Sans', sans-serif",
                fontSize: '10.5px',
                fontWeight: 700,
                padding: '6px 2px',
                cursor: 'pointer',
                margin: '-4px 2px',
                backgroundColor: accent,
                borderRadius: '12px'
              }}
            >
              <span style={{ fontSize: '17px', lineHeight: 1 }}>+</span>Add
            </button>

            <button
              onClick={() => setPanel('settings')}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '3px',
                background: 'none',
                border: 'none',
                color: 'oklch(0.68 0.006 90)',
                fontFamily: "'Work Sans', sans-serif",
                fontSize: '10.5px',
                fontWeight: 600,
                padding: '6px 2px',
                cursor: 'pointer'
              }}
            >
              <span style={{ fontSize: '16px' }}>⚙</span>Settings
            </button>

            <button
              onClick={() => setPanel('review')}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '3px',
                background: 'none',
                border: 'none',
                color: 'oklch(0.68 0.006 90)',
                fontFamily: "'Work Sans', sans-serif",
                fontSize: '10.5px',
                fontWeight: 600,
                padding: '6px 2px',
                cursor: 'pointer'
              }}
            >
              <span style={{ fontSize: '16px' }}>☰</span>Review
            </button>
          </nav>
        )}

        {/* MODAL: ADD / EDIT BLOCK */}
        {modal && (
          <div
            onClick={() => setModal(null)}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.5)',
              zIndex: 70,
              display: 'flex',
              alignItems: activeIsMobile ? 'flex-end' : 'center',
              justifyContent: 'center',
              animation: 'fadeIn 0.15s ease'
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={
                activeIsMobile
                  ? {
                      width: '100%',
                      maxHeight: '88%',
                      overflow: 'auto',
                      background: 'oklch(0.18 0.006 90)',
                      borderRadius: '20px 20px 0 0',
                      padding: '20px 18px calc(20px + env(safe-area-inset-bottom,0px))',
                      animation: 'sheetUp 0.22s ease'
                    }
                  : {
                      width: '420px',
                      background: 'oklch(0.19 0.006 90)',
                      border: '1px solid oklch(0.3 0.006 90)',
                      borderRadius: '16px',
                      padding: '24px',
                      boxShadow: '0 30px 60px -20px rgba(0,0,0,0.6)'
                    }
              }
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
                <span style={{ fontFamily: "'Work Sans', sans-serif", fontWeight: 600, fontSize: '16px' }}>
                  {modal.mode === 'add' ? 'Add block' : 'Edit block'}
                </span>
                <button
                  onClick={() => setModal(null)}
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '8px',
                    border: '1px solid oklch(0.3 0.006 90)',
                    background: 'oklch(0.22 0.006 90)',
                    color: 'oklch(0.7 0.006 90)',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  ×
                </button>
              </div>

              {/* Type pills */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
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

              {/* Title input */}
              <label
                style={{
                  display: 'block',
                  fontFamily: "'Work Sans', sans-serif",
                  fontSize: '12px',
                  color: 'oklch(0.6 0.006 90)',
                  marginBottom: '6px'
                }}
              >
                {modal.draft.type === 'buffer' ? 'Label (optional)' : 'Title'}
              </label>
              <input
                type="text"
                value={modal.draft.title}
                onChange={e => setModal({ ...modal, draft: { ...modal.draft, title: e.target.value } })}
                placeholder={modal.draft.type === 'buffer' ? 'e.g. Transition' : 'e.g. Deep work block'}
                style={{
                  width: '100%',
                  fontFamily: "'Work Sans', sans-serif",
                  fontSize: '14px',
                  background: 'oklch(0.21 0.006 90)',
                  border: '1px solid oklch(0.32 0.006 90)',
                  borderRadius: '9px',
                  padding: '10px 12px',
                  color: 'oklch(0.92 0.004 90)',
                  marginBottom: '16px'
                }}
              />

              {/* Time inputs */}
              <div style={{ display: 'flex', gap: '12px', marginBottom: '22px' }}>
                <div style={{ flex: 1 }}>
                  <label
                    style={{
                      display: 'block',
                      fontFamily: "'Work Sans', sans-serif",
                      fontSize: '12px',
                      color: 'oklch(0.6 0.006 90)',
                      marginBottom: '6px'
                    }}
                  >
                    Start
                  </label>
                  <input
                    type="time"
                    value={modal.draft.startStr}
                    onChange={e => setModal({ ...modal, draft: { ...modal.draft, startStr: e.target.value } })}
                    style={{
                      width: '100%',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '14px',
                      background: 'oklch(0.21 0.006 90)',
                      border: '1px solid oklch(0.32 0.006 90)',
                      borderRadius: '9px',
                      padding: '9px 10px',
                      color: 'oklch(0.92 0.004 90)'
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label
                    style={{
                      display: 'block',
                      fontFamily: "'Work Sans', sans-serif",
                      fontSize: '12px',
                      color: 'oklch(0.6 0.006 90)',
                      marginBottom: '6px'
                    }}
                  >
                    End
                  </label>
                  <input
                    type="time"
                    value={modal.draft.endStr}
                    onChange={e => setModal({ ...modal, draft: { ...modal.draft, endStr: e.target.value } })}
                    style={{
                      width: '100%',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '14px',
                      background: 'oklch(0.21 0.006 90)',
                      border: '1px solid oklch(0.32 0.006 90)',
                      borderRadius: '9px',
                      padding: '9px 10px',
                      color: 'oklch(0.92 0.004 90)'
                    }}
                  />
                </div>
              </div>

              {/* Modal buttons */}
              <div style={{ display: 'flex', gap: '10px' }}>
                {modal.mode === 'edit' && modal.id && (
                  <button
                    type="button"
                    onClick={() => handleDeleteBlock(modal.id!)}
                    style={{
                      fontFamily: "'Work Sans', sans-serif",
                      fontWeight: 600,
                      fontSize: '13.5px',
                      border: '1px solid oklch(0.35 0.02 25)',
                      background: 'oklch(0.22 0.02 25)',
                      color: 'oklch(0.75 0.14 25)',
                      borderRadius: '10px',
                      padding: '11px 16px',
                      cursor: 'pointer'
                    }}
                  >
                    Delete
                  </button>
                )}
                <div style={{ flex: 1 }} />
                <button
                  type="button"
                  onClick={() => setModal(null)}
                  style={{
                    fontFamily: "'Work Sans', sans-serif",
                    fontWeight: 600,
                    fontSize: '13.5px',
                    border: '1px solid oklch(0.32 0.006 90)',
                    background: 'none',
                    color: 'oklch(0.72 0.006 90)',
                    borderRadius: '10px',
                    padding: '11px 16px',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveDraft}
                  style={{
                    fontFamily: "'Work Sans', sans-serif",
                    fontWeight: 700,
                    fontSize: '13.5px',
                    border: 'none',
                    background: accent,
                    color: accentText,
                    borderRadius: '10px',
                    padding: '11px 18px',
                    cursor: 'pointer'
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {/* PANEL: SETTINGS & REVIEW */}
        {panel && (
          <div
            onClick={() => setPanel(null)}
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.45)',
              zIndex: 70,
              display: 'flex',
              alignItems: activeIsMobile ? 'flex-end' : 'stretch',
              justifyContent: 'flex-end',
              animation: 'fadeIn 0.15s ease'
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={
                activeIsMobile
                  ? {
                      width: '100%',
                      maxHeight: '90%',
                      overflowY: 'auto',
                      background: 'oklch(0.18 0.006 90)',
                      borderRadius: '20px 20px 0 0',
                      padding: '20px 18px calc(20px + env(safe-area-inset-bottom,0px))',
                      animation: 'sheetUp 0.22s ease'
                    }
                  : {
                      width: '380px',
                      height: '100%',
                      overflowY: 'auto',
                      background: 'oklch(0.18 0.006 90)',
                      borderLeft: '1px solid oklch(0.28 0.006 90)',
                      padding: '24px',
                      boxShadow: '-20px 0 40px -20px rgba(0,0,0,0.4)'
                    }
              }
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
                <span style={{ fontFamily: "'Work Sans', sans-serif", fontWeight: 600, fontSize: '16px' }}>
                  {panel === 'settings' ? 'Settings' : 'Day Review'}
                </span>
                <button
                  onClick={() => setPanel(null)}
                  style={{
                    width: '28px',
                    height: '28px',
                    borderRadius: '8px',
                    border: '1px solid oklch(0.3 0.006 90)',
                    background: 'oklch(0.22 0.006 90)',
                    color: 'oklch(0.7 0.006 90)',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  ×
                </button>
              </div>

              {/* Settings Content */}
              {panel === 'settings' && (
                <div>
                  <div style={{ marginBottom: '22px' }}>
                    <label
                      style={{
                        display: 'block',
                        fontFamily: "'Work Sans', sans-serif",
                        fontSize: '12px',
                        color: 'oklch(0.6 0.006 90)',
                        marginBottom: '8px'
                      }}
                    >
                      Timezone
                    </label>
                    <select
                      value={timezone}
                      onChange={e => handleSetTimezone(e.target.value)}
                      style={{
                        width: '100%',
                        fontFamily: "'Work Sans', sans-serif",
                        fontSize: '13.5px',
                        background: 'oklch(0.21 0.006 90)',
                        border: '1px solid oklch(0.32 0.006 90)',
                        borderRadius: '9px',
                        padding: '10px 12px',
                        color: 'oklch(0.92 0.004 90)'
                      }}
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
                    <label
                      style={{
                        display: 'block',
                        fontFamily: "'Work Sans', sans-serif",
                        fontSize: '12px',
                        color: 'oklch(0.6 0.006 90)',
                        marginBottom: '8px'
                      }}
                    >
                      Cascade behavior
                    </label>
                    <div
                      style={{
                        fontFamily: "'Work Sans', sans-serif",
                        fontSize: '12px',
                        color: 'oklch(0.55 0.006 90)',
                        marginBottom: '10px',
                        lineHeight: 1.5
                      }}
                    >
                      When moving a block pushes it into the next one, should Daylog offer to shift the rest of your day too?
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        background: 'oklch(0.21 0.006 90)',
                        border: '1px solid oklch(0.3 0.006 90)',
                        borderRadius: '10px',
                        padding: '3px',
                        gap: '3px'
                      }}
                    >
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

                  {activeIsMobile && (
                    <div style={{ marginTop: '28px', borderTop: '1px solid oklch(0.26 0.006 90)', paddingTop: '16px' }}>
                      <form action="/auth/signout" method="post">
                        <button
                          type="submit"
                          style={{
                            width: '100%',
                            fontFamily: "'Work Sans', sans-serif",
                            fontSize: '13.5px',
                            fontWeight: 600,
                            padding: '11px',
                            borderRadius: '10px',
                            border: '1px solid oklch(0.32 0.006 90)',
                            background: 'oklch(0.22 0.006 90)',
                            color: 'oklch(0.8 0.006 90)',
                            cursor: 'pointer'
                          }}
                        >
                          Sign out
                        </button>
                      </form>
                    </div>
                  )}
                </div>
              )}

              {/* Day Review Content */}
              {panel === 'review' && (
                <div style={{ background: 'oklch(0.21 0.006 90)', border: '1px solid oklch(0.3 0.006 90)', borderRadius: '14px', padding: '18px' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '12px' }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '26px', fontWeight: 600, color: accent }}>
                      {completedCount}
                    </span>
                    <span style={{ fontFamily: "'Work Sans', sans-serif", fontSize: '13px', color: 'oklch(0.6 0.006 90)' }}>
                      of {tasksOnly.length} tasks completed
                    </span>
                  </div>
                  <p style={{ fontFamily: "'Work Sans', sans-serif", fontSize: '13.5px', lineHeight: 1.65, color: 'oklch(0.82 0.004 90)', margin: 0 }}>
                    {reviewText}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* CASCADE PROMPT POPOVER */}
        {cascadePrompt && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: activeIsMobile ? '84px' : '24px',
              transform: 'translateX(-50%)',
              width: 'min(320px, 88%)',
              background: 'oklch(0.24 0.008 70)',
              border: '1px solid oklch(0.4 0.03 70)',
              borderRadius: '13px',
              padding: '14px 16px',
              boxShadow: '0 16px 34px -12px rgba(0,0,0,0.5)',
              zIndex: 60,
              animation: 'fadeIn 0.15s ease'
            }}
          >
            <div
              style={{
                fontFamily: "'Work Sans', sans-serif",
                fontSize: '13.5px',
                color: 'oklch(0.94 0.006 90)',
                marginBottom: '12px',
                lineHeight: 1.4
              }}
            >
              Shift {cascadePrompt.count} following item{cascadePrompt.count > 1 ? 's' : ''} by {Math.abs(cascadePrompt.delta)} min?
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setCascadePrompt(null)}
                style={{
                  flex: 1,
                  fontFamily: "'Work Sans', sans-serif",
                  fontWeight: 600,
                  fontSize: '12.5px',
                  border: '1px solid oklch(0.4 0.01 90)',
                  background: 'none',
                  color: 'oklch(0.85 0.006 90)',
                  borderRadius: '8px',
                  padding: '8px 10px',
                  cursor: 'pointer'
                }}
              >
                Don't cascade
              </button>
              <button
                onClick={() => applyCascade(cascadePrompt.chain, cascadePrompt.delta)}
                style={{
                  flex: 1,
                  fontFamily: "'Work Sans', sans-serif",
                  fontWeight: 700,
                  fontSize: '12.5px',
                  border: 'none',
                  background: accent,
                  color: accentText,
                  borderRadius: '8px',
                  padding: '8px 10px',
                  cursor: 'pointer'
                }}
              >
                Cascade
              </button>
            </div>
          </div>
        )}

        {/* FLOATING TOAST NOTIFICATION */}
        {toast && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              bottom: activeIsMobile ? '84px' : '24px',
              transform: 'translateX(-50%)',
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              background: 'oklch(0.23 0.006 90)',
              border: '1px solid oklch(0.32 0.006 90)',
              borderRadius: '11px',
              padding: '10px 10px 10px 16px',
              boxShadow: '0 14px 30px -10px rgba(0,0,0,0.5)',
              zIndex: 55,
              animation: 'toastIn 0.18s ease'
            }}
          >
            <span style={{ fontFamily: "'Work Sans', sans-serif", fontSize: '13px', color: 'oklch(0.88 0.004 90)' }}>
              {toast.msg}
            </span>
            <button
              onClick={handleUndo}
              style={{
                fontFamily: "'Work Sans', sans-serif",
                fontWeight: 700,
                fontSize: '12.5px',
                border: 'none',
                background: 'none',
                color: accent,
                cursor: 'pointer',
                padding: '4px 8px'
              }}
            >
              Undo
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
