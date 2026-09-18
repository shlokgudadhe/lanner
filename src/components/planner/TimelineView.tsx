'use client'

import React, { useState, useEffect, useRef, useMemo, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { format, differenceInMinutes, startOfDay, parseISO, isSameDay, addDays } from 'date-fns'
import { PlannerItem } from '@/types'
import { createItem, updateItem, deleteItem } from '@/app/actions/items'
import { logUndo, performUndo } from '@/app/actions/undo'
import { updateProfile } from '@/app/actions/profile'
import { createClient } from '@/utils/supabase/client'

const MIN_START = 360  // 06:00 (6 AM)
const MIN_END = 1440   // 24:00 (12 AM next day)
const SNAP_MINUTES = 5

const pad2 = (n: number) => String(n).padStart(2, '0')
const fmt24 = (m: number) => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60)
const fmt12h = (h: number) => (h === 12 ? '12 PM' : h === 0 || h === 24 ? '12 AM' : h > 12 ? (h - 12) + ' PM' : h + ' AM')
const fmtTime12h = (m: number) => {
  const h = Math.floor(m / 60)
  const min = Math.floor(m % 60)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 || 12
  return `${h12}:${pad2(min)} ${ampm}`
}
const toMin = (str: string) => {
  const [h, m] = str.split(':').map(Number)
  return h * 60 + m
}

interface TimelineViewProps {
  initialItems: PlannerItem[]
  day: string
  cascadePreference: string
  initialTimezone?: string
  userEmail?: string
}

interface LocalBlock {
  id: string
  type: 'task' | 'buffer'
  title: string
  description?: string | null
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
  initialTimezone = 'America/Los_Angeles',
  userEmail = ''
}: TimelineViewProps) {
  const router = useRouter()

  // Dynamic viewport detection: purely automatic by viewport width
  const [isMobile, setIsMobile] = useState(false)

  // Local state for planner blocks
  const [optimisticDay, setOptimisticDay] = useState(day)

  useEffect(() => {
    setOptimisticDay(day)
  }, [day])

  useEffect(() => {
    const nextStr = format(addDays(parseISO(day), 1), 'yyyy-MM-dd')
    const prevStr = format(addDays(parseISO(day), -1), 'yyyy-MM-dd')
    router.prefetch(`/planner?day=${nextStr}`)
    router.prefetch(`/planner?day=${prevStr}`)
  }, [day, router])

  const [blocks, setBlocks] = useState<LocalBlock[]>([])
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [detailBlock, setDetailBlock] = useState<LocalBlock | null>(null)
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [now, setNow] = useState(new Date())

  // Settings & preferences
  const [cascadeMode, setCascadeMode] = useState<'always' | 'ask' | 'never'>(
    (cascadePreference as 'always' | 'ask' | 'never') || 'ask'
  )
  const [timezone, setTimezone] = useState(initialTimezone)

  // UI Modals & Panels
  const [modal, setModal] = useState<{
    mode: 'add' | 'edit'
    id?: string
    draft: {
      type: 'task' | 'buffer'
      title: string
      description?: string
      startStr: string
      endStr: string
    }
  } | null>(null)

  const [panel, setPanel] = useState<'settings' | 'overview' | null>(null)
  const [cascadePrompt, setCascadePrompt] = useState<{
    direction: 'up' | 'down'
    draggedId: string
    pushChain: string[]
    pushDelta: number
    fillChain: string[]
    fillDelta: number
    snapshot: any[]
  } | null>(null)

  const [toast, setToast] = useState<{ msg: string } | null>(null)
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Drag & movement refs
  const dragRef = useRef<{
    mode: 'move' | 'resize'
    id: string
    startY: number
    origStart: number
    origEnd: number
  } | null>(null)
  const hasMovedRef = useRef<boolean>(false)

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
          description: i.description || null,
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

  // Realtime Supabase Subscription for Cross-Device / Cross-Session Sync
  useEffect(() => {
    const supabase = createClient()
    const baseDay = parseISO(day)
    const dayStart = startOfDay(baseDay)
    
    let channel: any

    const initRealtime = async () => {
      // Ensure the socket is authenticated before subscribing so RLS rules pass
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) return

      channel = supabase
        .channel(`realtime-items-${day}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'items',
            filter: `day=eq.${day}`
          },
          (payload) => {
            if (payload.eventType === 'INSERT') {
              const newItem = payload.new as PlannerItem
              if (!newItem.is_deleted) {
                setBlocks(prev => {
                  if (prev.some(b => b.id === newItem.id)) return prev
                  const start = parseISO(newItem.start_time)
                  const end = parseISO(newItem.end_time)
                  const newBlock: LocalBlock = {
                    id: newItem.id,
                    type: (newItem.is_buffer ? 'buffer' : 'task') as 'task' | 'buffer',
                    title: newItem.title || (newItem.is_buffer ? 'Buffer' : 'Untitled'),
                    description: newItem.description || null,
                    startMin: differenceInMinutes(start, dayStart),
                    endMin: differenceInMinutes(end, dayStart),
                    completed: !!newItem.is_completed,
                    completedAt: newItem.completed_at,
                    sortOrder: newItem.sort_order || 0
                  }
                  return [...prev, newBlock].sort((a, b) => a.startMin - b.startMin)
                })
              }
            } else if (payload.eventType === 'UPDATE') {
              const updatedItem = payload.new as PlannerItem
              if (updatedItem.is_deleted) {
                setBlocks(prev => prev.filter(b => b.id !== updatedItem.id))
              } else {
                const start = parseISO(updatedItem.start_time)
                const end = parseISO(updatedItem.end_time)
                setBlocks(prev => {
                  const existingIdx = prev.findIndex(b => b.id === updatedItem.id)
                  const updatedBlock: LocalBlock = {
                    id: updatedItem.id,
                    type: (updatedItem.is_buffer ? 'buffer' : 'task') as 'task' | 'buffer',
                    title: updatedItem.title || (updatedItem.is_buffer ? 'Buffer' : 'Untitled'),
                    description: updatedItem.description || null,
                    startMin: differenceInMinutes(start, dayStart),
                    endMin: differenceInMinutes(end, dayStart),
                    completed: !!updatedItem.is_completed,
                    completedAt: updatedItem.completed_at,
                    sortOrder: updatedItem.sort_order || 0
                  }
                  if (existingIdx >= 0) {
                    const copy = [...prev]
                    copy[existingIdx] = updatedBlock
                    return copy.sort((a, b) => a.startMin - b.startMin)
                  }
                  return [...prev, updatedBlock].sort((a, b) => a.startMin - b.startMin)
                })
              }
            } else if (payload.eventType === 'DELETE') {
              const oldItem = payload.old as { id: string }
              if (oldItem?.id) {
                setBlocks(prev => prev.filter(b => b.id !== oldItem.id))
              }
            }

          }
        )
        .subscribe()
    }

    initRealtime()

    return () => {
      if (channel) supabase.removeChannel(channel)
    }
  }, [day])

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
  }, [day])

  // Toast notification
  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({ msg })
    toastTimerRef.current = setTimeout(() => setToast(null), 4000)
  }

  // Handle undo (reverts from DB atomic undo_log and updates local state)
  const handleUndo = async () => {
    setDetailBlock(null)
    setModal(null)
    setCascadePrompt(null)
    
    try {
      showToast('Undoing...')
      const res = await performUndo()
      if (!res.success) {
        showToast('Nothing to undo')
        return
      }

      // If action was on another day, navigate there
      if (res.day && res.day !== day) {
        startTransition(() => {
          router.push(`/planner?day=${res.day}`)
        })
        showToast('Reverted action on ' + res.day)
        return
      }

      // Reconcile local state immediately with reverted items
      const baseDay = parseISO(day)
      const dayStart = startOfDay(baseDay)

      if (res.actionType === 'create') {
        const createdId = res.payload?.id
        setBlocks(prev => prev.filter(b => b.id !== createdId))
      } else if (res.actionType === 'update' && res.revertedItems && res.revertedItems.length > 0) {
        setBlocks(prev => {
          let updatedList = [...prev]
          for (const item of res.revertedItems!) {
            if (item.is_deleted) {
              updatedList = updatedList.filter(b => b.id !== item.id)
            } else {
              const start = parseISO(item.start_time)
              const end = parseISO(item.end_time)
              const blockData: LocalBlock = {
                id: item.id,
                type: (item.is_buffer ? 'buffer' : 'task') as 'task' | 'buffer',
                title: item.title || (item.is_buffer ? 'Buffer' : 'Untitled'),
                description: item.description || null,
                startMin: differenceInMinutes(start, dayStart),
                endMin: differenceInMinutes(end, dayStart),
                completed: !!item.is_completed,
                completedAt: item.completed_at,
                sortOrder: item.sort_order || 0
              }
              const idx = updatedList.findIndex(b => b.id === item.id)
              if (idx >= 0) {
                updatedList[idx] = blockData
              } else {
                updatedList.push(blockData)
              }
            }
          }
          return updatedList.sort((a, b) => a.startMin - b.startMin)
        })
      }

      setCascadePrompt(null)
      showToast('Action undone')
      startTransition(() => {
        router.refresh()
      })
    } catch (err) {
      console.error('Error in handleUndo:', err)
      showToast('Failed to undo')
    }
  }

  // Flexible Timeline Scaling Engine
  const hourScales = useMemo(() => {
    const scales = new Array(24).fill(isMobile ? 1.2 : 1.6)
    const defaultScale = isMobile ? 1.2 : 1.6
    const minBlockHeight = 32

    for (let h = 0; h < 24; h++) {
      const startHourMin = h * 60
      const endHourMin = startHourMin + 60
      let minDur = 60
      let hasBlocks = false

      for (const b of blocks) {
        if (b.id === draggingId) continue // Prevent infinite scaling loops during drag

        if (b.startMin < endHourMin && b.endMin > startHourMin) {
          const dur = b.endMin - b.startMin
          if (dur < minDur) minDur = dur
          hasBlocks = true
        }
      }

      if (hasBlocks) {
        minDur = Math.max(5, minDur)
        const requiredScale = minBlockHeight / minDur
        scales[h] = Math.max(defaultScale, requiredScale)
      }
    }
    return scales
  }, [blocks, isMobile, draggingId])

  const getOffsetForMinute = (min: number) => {
    if (min <= MIN_START) return 0
    let offset = 0
    let m = MIN_START
    while (m < min) {
      const currentHour = Math.floor(m / 60)
      const nextHourStart = (currentHour + 1) * 60
      const end = Math.min(min, nextHourStart)
      const scale = hourScales[currentHour] || (isMobile ? 1.2 : 1.6)
      offset += (end - m) * scale
      m = end
    }
    return offset
  }

  const getMinuteForOffset = (y: number) => {
    if (y <= 0) return MIN_START
    let currentY = 0
    let m = MIN_START
    while (m < MIN_END) {
      const currentHour = Math.floor(m / 60)
      const scale = hourScales[currentHour] || (isMobile ? 1.2 : 1.6)
      const nextHourStart = (currentHour + 1) * 60
      const minInSegment = nextHourStart - m
      const segmentHeight = minInSegment * scale

      if (currentY + segmentHeight >= y) {
        const remainderY = y - currentY
        return m + (remainderY / scale)
      }
      currentY += segmentHeight
      m = nextHourStart
    }
    return MIN_END
  }

  const gutterWidth = isMobile ? 54 : 68
  const blockRight = isMobile ? 8 : 20

  // Date helpers
  const targetDate = parseISO(optimisticDay)
  const isToday = isSameDay(targetDate, now)
  const nowMinutes = differenceInMinutes(now, startOfDay(now))
  const nowTop = getOffsetForMinute(nowMinutes)
  const dateLabel = format(targetDate, isMobile ? 'EEE, MMM d' : 'EEEE, MMMM do')

  const dateInputRef = useRef<HTMLInputElement>(null)
  
  const [isPending, startTransition] = useTransition()
  const isNavigating = isPending || optimisticDay !== day

  const changeDate = (delta: number) => {
    const next = addDays(targetDate, delta)
    const nextStr = format(next, 'yyyy-MM-dd')
    setOptimisticDay(nextStr)
    startTransition(() => {
      router.push(`/planner?day=${nextStr}`)
    })
  }

  const goDate = (dateStr: string) => {
    if (!dateStr) return
    setOptimisticDay(dateStr)
    startTransition(() => {
      router.push(`/planner?day=${dateStr}`)
    })
  }

  const goToday = () => {
    const todayStr = format(new Date(), 'yyyy-MM-dd')
    setOptimisticDay(todayStr)
    startTransition(() => {
      router.push(`/planner?day=${todayStr}`)
    })
  }

  // Toggle complete
  const toggleComplete = async (id: string) => {
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

  // Reorder in overview
  const handleOverviewReorder = async (index: number, direction: 'up' | 'down') => {
    const sorted = blocks.slice().sort((a, b) => a.startMin - b.startMin)
    if (direction === 'up' && index === 0) return
    if (direction === 'down' && index === sorted.length - 1) return

    const b1 = sorted[index]
    const b2 = direction === 'up' ? sorted[index - 1] : sorted[index + 1]

    const dur1 = b1.endMin - b1.startMin
    const dur2 = b2.endMin - b2.startMin

    const isAdjacent = b1.endMin === b2.startMin || b2.endMin === b1.startMin

    let newStart1, newStart2
    if (isAdjacent) {
      if (b1.startMin < b2.startMin) {
        newStart2 = b1.startMin
        newStart1 = newStart2 + dur2
      } else {
        newStart1 = b2.startMin
        newStart2 = newStart1 + dur1
      }
    } else {
      newStart1 = b2.startMin
      newStart2 = b1.startMin
    }

    const newEnd1 = newStart1 + dur1
    const newEnd2 = newStart2 + dur2

    setBlocks(prev => prev.map(b => {
      if (b.id === b1.id) return { ...b, startMin: newStart1, endMin: newEnd1 }
      if (b.id === b2.id) return { ...b, startMin: newStart2, endMin: newEnd2 }
      return b
    }))

    const startIso1 = new Date(`${day}T${fmt24(newStart1)}:00`).toISOString()
    const endIso1 = new Date(`${day}T${fmt24(newEnd1)}:00`).toISOString()
    const startIso2 = new Date(`${day}T${fmt24(newStart2)}:00`).toISOString()
    const endIso2 = new Date(`${day}T${fmt24(newEnd2)}:00`).toISOString()

    try {
      await Promise.all([
        updateItem(b1.id, { start_time: startIso1, end_time: endIso1 }),
        updateItem(b2.id, { start_time: startIso2, end_time: endIso2 })
      ])
      await logUndo('update', { items: [
        { id: b1.id, start_time: new Date(`${day}T${fmt24(b1.startMin)}:00`).toISOString(), end_time: new Date(`${day}T${fmt24(b1.endMin)}:00`).toISOString() },
        { id: b2.id, start_time: new Date(`${day}T${fmt24(b2.startMin)}:00`).toISOString(), end_time: new Date(`${day}T${fmt24(b2.endMin)}:00`).toISOString() }
      ]}, day)
    } catch (err) {
      console.error('Error reordering items:', err)
    }
  }

  // Modal open/close
  const openAdd = () => {
    let defaultStart = MIN_START
    if (blocks.length > 0) {
      const maxEnd = Math.max(...blocks.map(b => b.endMin))
      defaultStart = Math.min(MIN_END - 30, Math.max(MIN_START, maxEnd))
    } else {
      defaultStart = Math.max(MIN_START, Math.floor(nowMinutes / 30) * 30 || 600)
    }

    setModal({
      mode: 'add',
      draft: {
        type: 'task',
        title: '',
        description: '',
        startStr: fmt24(defaultStart),
        endStr: fmt24(Math.min(MIN_END, defaultStart + 30))
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
        description: block.description || '',
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
    const description = draft.description?.trim() || null

    if (endMin <= startMin) {
      showToast('End time must be after start')
      return
    }

    const startIso = new Date(`${day}T${fmt24(startMin)}:00`).toISOString()
    const endIso = new Date(`${day}T${fmt24(endMin)}:00`).toISOString()

    if (mode === 'add') {
      const isBuffer = draft.type === 'buffer'
      const title = isBuffer ? (draft.title.trim() || 'Buffer') : (draft.title.trim() || 'Untitled')

      const tempId = crypto.randomUUID()
      const newBlock: LocalBlock = {
        id: tempId,
        type: draft.type,
        title,
        description,
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
          id: tempId,
          title,
          description,
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

      const prev = blocks.find(b => b.id === id)
      if (prev) {
        logUndo('update', {
          items: [{
            id,
            title: prev.title,
            description: prev.description || null,
            is_buffer: prev.type === 'buffer',
            start_time: new Date(`${day}T${fmt24(prev.startMin)}:00`).toISOString(),
            end_time: new Date(`${day}T${fmt24(prev.endMin)}:00`).toISOString()
          }]
        }, day).catch(console.error)
      }

      setBlocks(prev =>
        prev
          .map(b => (b.id === id ? { ...b, type: draft.type, title, description, startMin, endMin } : b))
          .sort((a, b) => a.startMin - b.startMin)
      )
      setModal(null)
      showToast('Block updated')

      try {
        await updateItem(id, {
          title,
          description,
          start_time: startIso,
          end_time: endIso,
          is_buffer: isBuffer
        })
      } catch (err) {
        console.error('Error updating item:', err)
      }
    }
  }

  // Convert buffer to task action
  const handleConvertBuffer = async (id: string) => {
    const target = blocks.find(b => b.id === id)
    if (!target) return
    const newTitle = target.title === 'Buffer' || !target.title.trim() ? 'Task' : target.title
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, type: 'task', title: newTitle } : b))
    showToast('Converted to task')

    try {
      await updateItem(id, { is_buffer: false, title: newTitle })
      await logUndo('update', { items: [{ id, is_buffer: true, title: target.title }] }, day)
    } catch (err) {
      console.error('Error converting buffer to task:', err)
    }
  }

  // Update description from Detail Panel
  const handleSaveDetailDesc = async (id: string, newDesc: string) => {
    const target = blocks.find(b => b.id === id)
    if (!target) return
    const trimmed = newDesc.trim() || null
    if (trimmed === (target.description || null)) return

    const prevDesc = target.description || null
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, description: trimmed } : b))

    try {
      await updateItem(id, { description: trimmed })
      await logUndo('update', { items: [{ id, description: prevDesc }] }, day)
      showToast('Notes saved')
    } catch (err) {
      console.error('Error updating description:', err)
    }
  }

  // Update title from Detail Panel
  const handleSaveDetailTitle = async (id: string, newTitle: string) => {
    const target = blocks.find(b => b.id === id)
    if (!target) return
    const trimmed = newTitle.trim() || (target.type === 'buffer' ? 'Buffer' : 'Untitled')
    if (trimmed === target.title) return

    const prevTitle = target.title
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, title: trimmed } : b))

    try {
      await updateItem(id, { title: trimmed })
      await logUndo('update', { items: [{ id, title: prevTitle }] }, day)
    } catch (err) {
      console.error('Error updating title:', err)
    }
  }

  // Duplicate Block
  const handleDuplicateBlock = async (block: LocalBlock) => {
    const duration = block.endMin - block.startMin
    let nextStart = block.endMin
    
    const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin)
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].startMin >= nextStart) {
        if (sorted[i].startMin - nextStart >= duration) {
          break // Found a gap!
        }
        nextStart = Math.max(nextStart, sorted[i].endMin)
      }
    }

    if (nextStart + duration > MIN_END) {
      nextStart = block.endMin
    }

    const tempId = crypto.randomUUID()
    const newBlock: LocalBlock = {
      ...block,
      id: tempId,
      startMin: nextStart,
      endMin: nextStart + duration,
      completed: false,
      completedAt: null,
      sortOrder: blocks.length + 1
    }
    setBlocks(prev => [...prev, newBlock].sort((a, b) => a.startMin - b.startMin))
    setDetailBlock(null)
    showToast('Block duplicated')

    try {
      const startIso = new Date(`${day}T${fmt24(newBlock.startMin)}:00`).toISOString()
      const endIso = new Date(`${day}T${fmt24(newBlock.endMin)}:00`).toISOString()
      
      const saved = await createItem({
        id: tempId,
        title: newBlock.title,
        description: newBlock.description,
        start_time: startIso,
        end_time: endIso,
        is_buffer: newBlock.type === 'buffer',
        is_completed: false,
        day
      })
      setBlocks(prev => prev.map(b => b.id === tempId ? { ...b, id: saved.id } : b))
      await logUndo('create', { id: saved.id }, day)
    } catch (err) {
      console.error('Error duplicating item:', err)
    }
  }

  // Pointer Drag & Resize Handlers
  const startDrag = (mode: 'move' | 'resize', block: LocalBlock, e: React.PointerEvent) => {
    e.stopPropagation()
    hasMovedRef.current = false

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
      if (Math.abs(ev.clientY - d.startY) > 3) {
        hasMovedRef.current = true
      }
      const targetY = getOffsetForMinute(d.origStart) + (ev.clientY - d.startY)
      const rawMin = getMinuteForOffset(targetY)
      const deltaMin = Math.round((rawMin - d.origStart) / SNAP_MINUTES) * SNAP_MINUTES

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

      let sideEffectData: any = null

      setBlocks(currentBlocks => {
        const moved = currentBlocks.find(t => t.id === d.id)
        if (!moved) return currentBlocks

        const delta = d.mode === 'move' ? moved.startMin - d.origStart : moved.endMin - d.origEnd
        if (delta === 0) return currentBlocks

        const movedDur = d.origEnd - d.origStart
        const origStartIso = new Date(`${day}T${fmt24(d.origStart)}:00`).toISOString()
        const origEndIso = new Date(`${day}T${fmt24(d.origEnd)}:00`).toISOString()

        const startIso = new Date(`${day}T${fmt24(moved.startMin)}:00`).toISOString()
        const endIso = new Date(`${day}T${fmt24(moved.endMin)}:00`).toISOString()

        // Symmetric bidirectional cascade calculation
        let pushChain: string[] = []
        let pushDelta = delta
        let fillChain: string[] = []
        let fillDelta = 0

        const sorted = currentBlocks.filter(t => t.type === 'task').sort((a, b) => a.startMin - b.startMin)
        const idx = sorted.findIndex(t => t.id === d.id)

        if (delta > 0) {
          // Dragged LATER (down)
          // 1. Push chain: subsequent tasks that collide/overlap
          let prevEnd = moved.endMin
          for (let k = idx + 1; k < sorted.length; k++) {
            if (sorted[k].startMin < prevEnd) {
              pushChain.push(sorted[k].id)
              prevEnd = sorted[k].endMin + delta
            } else break
          }

          // 2. Fill gap chain: intermediate tasks between old position and new position
          fillChain = currentBlocks
            .filter(t => t.id !== moved.id && t.startMin >= d.origEnd && t.endMin <= moved.startMin)
            .map(t => t.id)
          fillDelta = -movedDur
        } else if (delta < 0) {
          // Dragged EARLIER (up)
          // 1. Push chain: earlier tasks that collide/overlap
          let nextStart = moved.startMin
          for (let k = idx - 1; k >= 0; k--) {
            if (sorted[k].endMin > nextStart) {
              pushChain.push(sorted[k].id)
              nextStart = sorted[k].startMin + delta
            } else break
          }
          pushChain.reverse()

          // 2. Fill gap chain: intermediate tasks between new position and old position
          fillChain = currentBlocks
            .filter(t => t.id !== moved.id && t.startMin >= moved.endMin && t.endMin <= d.origStart)
            .map(t => t.id)
          fillDelta = movedDur
        }

        const allCandidateIds = Array.from(new Set([...pushChain, ...fillChain]))
        const cascadeSnapshot = [
          { id: moved.id, start_time: origStartIso, end_time: origEndIso },
          ...allCandidateIds.map(cid => {
            const cItem = currentBlocks.find(b => b.id === cid)!
            return {
              id: cid,
              start_time: new Date(`${day}T${fmt24(cItem.startMin)}:00`).toISOString(),
              end_time: new Date(`${day}T${fmt24(cItem.endMin)}:00`).toISOString()
            }
          })
        ]

        sideEffectData = {
          moved,
          delta,
          startIso,
          endIso,
          origStartIso,
          origEndIso,
          pushChain,
          fillChain,
          pushDelta,
          fillDelta,
          cascadeSnapshot,
          currentBlocks
        }

        return currentBlocks
      })

      // Execute side-effects safely outside the pure updater function
      if (sideEffectData) {
        const {
          moved, delta, startIso, endIso, origStartIso, origEndIso,
          pushChain, fillChain, pushDelta, fillDelta, cascadeSnapshot, currentBlocks
        } = sideEffectData

        // Sync moved item to Supabase
        updateItem(moved.id, { start_time: startIso, end_time: endIso }).catch(console.error)

        if (pushChain.length > 0 || fillChain.length > 0) {
          if (cascadeMode === 'never') {
            if (pushChain.length > 0) showToast('Times now overlap')
            logUndo('update', { items: [{ id: moved.id, start_time: origStartIso, end_time: origEndIso }] }, day).catch(console.error)
          } else if (cascadeMode === 'always') {
            const chosenChain = pushChain.length > 0 ? pushChain : fillChain
            const chosenDelta = pushChain.length > 0 ? pushDelta : fillDelta
            applyCascade(chosenChain, chosenDelta, currentBlocks, cascadeSnapshot)
          } else {
            setCascadePrompt({
              direction: delta > 0 ? 'down' : 'up',
              draggedId: moved.id,
              pushChain,
              pushDelta,
              fillChain,
              fillDelta,
              snapshot: cascadeSnapshot
            })
          }
        } else {
          // No cascade, single moved/resized item logged atomically
          logUndo('update', { items: [{ id: moved.id, start_time: origStartIso, end_time: origEndIso }] }, day).catch(console.error)
        }
      }
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    setDraggingId(block.id)
  }

  // Cascade shift execution with atomic undo logging
  const applyCascade = async (chain: string[], delta: number, currentList = blocks, atomicSnapshot?: any[]) => {
    const updated = currentList.map(t =>
      chain.includes(t.id) ? { ...t, startMin: t.startMin + delta, endMin: t.endMin + delta } : t
    )
    setBlocks(updated)
    setCascadePrompt(null)
    showToast(`Shifted ${chain.length} item${chain.length > 1 ? 's' : ''}`)

    if (atomicSnapshot && atomicSnapshot.length > 0) {
      logUndo('update', { items: atomicSnapshot }, day).catch(console.error)
    }

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
    const top = getOffsetForMinute(h * 60)
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

  // Removed old review panel computations

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
    <div className="fixed inset-0 flex flex-col bg-[oklch(0.16_0.006_90)] text-[oklch(0.92_0.004_90)] overflow-hidden font-sans select-none">
      {/* =========================================================================
          1. HEADER (EDGE-TO-EDGE, RESPONSIVE)
      ========================================================================== */}
      {/* Mobile Header (< md) */}
      <header className="relative flex md:hidden w-full items-center justify-between px-3 py-2.5 sm:px-4 border-b border-[oklch(0.24_0.006_90)] bg-[oklch(0.18_0.006_90)] shrink-0 z-30">
        <span className="font-bold text-[16px] tracking-tight text-[oklch(0.94_0.004_90)]">
          LockIn
        </span>

        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1.5">
          <button
            onClick={() => changeDate(-1)}
            className="w-7 h-7 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center cursor-pointer"
          >
            ‹
          </button>
          <div 
            className="text-center min-w-[96px] relative cursor-pointer group"
            onClick={() => {
              if (dateInputRef.current && 'showPicker' in dateInputRef.current) {
                try {
                  dateInputRef.current.showPicker()
                } catch (e) {
                  console.error(e)
                }
              }
            }}
          >
            <div className="font-semibold text-[13px] text-[oklch(0.92_0.004_90)] group-hover:text-white transition-colors">{dateLabel}</div>
            {isToday && (
              <div className="font-mono text-[10px] text-[#d9a441] leading-none">
                now {format(now, 'HH:mm')}
              </div>
            )}
            {isNavigating && <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 w-4 h-0.5 bg-[oklch(0.72_0.006_90)] rounded-full animate-pulse" />}
            <input 
              ref={dateInputRef}
              type="date"
              value={format(targetDate, 'yyyy-MM-dd')}
              onChange={e => goDate(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            />
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
            onClick={() => setPanel('overview')}
            className="w-8 h-8 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center cursor-pointer"
            title="Day Overview"
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
      <header className="relative hidden md:flex w-full items-center justify-between px-8 py-4 border-b border-[oklch(0.24_0.006_90)] bg-[oklch(0.18_0.006_90)] shrink-0 z-30">
        <div className="flex items-center gap-3">
          <span className="font-bold text-xl tracking-tight text-[oklch(0.94_0.004_90)]">
            LockIn
          </span>
        </div>

        {/* Center: Date Navigation */}
        <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3">
          <button
            onClick={() => changeDate(-1)}
            className="w-8 h-8 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-base flex items-center justify-center hover:bg-[oklch(0.24_0.006_90)] cursor-pointer transition-colors"
          >
            ‹
          </button>
          <div 
            className="text-center min-w-[170px] relative cursor-pointer group"
            onClick={() => {
              if (dateInputRef.current && 'showPicker' in dateInputRef.current) {
                try {
                  dateInputRef.current.showPicker()
                } catch (e) {
                  console.error(e)
                }
              }
            }}
          >
            <div className="font-semibold text-[15px] text-[oklch(0.94_0.004_90)] group-hover:text-white transition-colors">{dateLabel}</div>
            <div className="font-mono text-[11px] text-[#d9a441] tracking-wide h-[16px]">
              {isToday ? 'now ' + format(now, 'HH:mm') : ''}
            </div>
            {isNavigating && <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-[oklch(0.72_0.006_90)] rounded-full animate-pulse" />}
            <input 
              ref={dateInputRef}
              type="date"
              value={format(targetDate, 'yyyy-MM-dd')}
              onChange={e => goDate(e.target.value)}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            />
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
              cursor: 'pointer',
              background: 'oklch(0.2 0.006 90)',
              color: 'oklch(0.78 0.006 90)'
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
            onClick={() => setPanel('overview')}
            className="w-9 h-9 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.2_0.006_90)] text-[oklch(0.75_0.006_90)] text-sm flex items-center justify-center hover:bg-[oklch(0.24_0.006_90)] cursor-pointer transition-colors"
            title="Day Overview"
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
              height: `${getOffsetForMinute(MIN_END) + 40}px`
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
            {(!isNavigating ? blocks : []).map(b => {
              const top = getOffsetForMinute(b.startMin)
              const durationMin = b.endMin - b.startMin
              const naturalHeight = getOffsetForMinute(b.endMin) - top
              // Minimum block height floor of 32px is now guaranteed by the scale engine!
              const height = naturalHeight
              const isSmall = durationMin < 20 || height < 40
              const timeLabel = `${fmt24(b.startMin)}–${fmt24(b.endMin)}`

              if (b.type === 'buffer') {
                return (
                  <div
                    key={b.id}
                    className="hatch group"
                    onClick={() => {
                      if (hasMovedRef.current) {
                        hasMovedRef.current = false
                        return
                      }
                      setDetailBlock(b)
                    }}
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
                      overflow: 'hidden',
                      cursor: 'pointer',
                      opacity: b.completed ? 0.5 : 1,
                      zIndex: draggingId === b.id ? 20 : 3
                    }}
                  >
                    <div
                      onPointerDown={e => startDrag('move', b, e)}
                      className="flex items-center gap-2 w-full h-full px-2.5 overflow-hidden cursor-grab active:cursor-grabbing"
                      style={{ touchAction: 'none' }}
                    >
                      {/* Buffer Checkbox */}
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          toggleComplete(b.id)
                        }}
                        style={{
                          width: '16px',
                          height: '16px',
                          borderRadius: '5px',
                          border: `1.5px solid ${b.completed ? accent : 'oklch(0.45 0.006 90)'}`,
                          background: b.completed ? accent : 'transparent',
                          color: accentText,
                          fontSize: '10px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          padding: 0,
                          flexShrink: 0
                        }}
                        title={b.completed ? 'Mark pending' : 'Mark completed'}
                      >
                        {b.completed ? '✓' : ''}
                      </button>

                      {/* Buffer title & time */}
                      <span
                        className="font-medium text-xs truncate flex-1 min-w-0"
                        style={{
                          color: b.completed ? 'oklch(0.48 0.006 90)' : 'oklch(0.8 0.006 90)',
                          textDecoration: b.completed ? 'line-through' : 'none'
                        }}
                      >
                        {b.title}
                      </span>

                      <span
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                        className="text-[10px] text-[oklch(0.58 0.006 90)] tracking-wide flex-shrink-0 whitespace-nowrap font-medium"
                      >
                        buffer · {timeLabel}
                      </span>
                    </div>

                    {/* Resize Handle */}
                    <div
                      onPointerDown={e => startDrag('resize', b, e)}
                      className="absolute left-1/2 -translate-x-1/2 bottom-0 w-12 h-3 cursor-ns-resize opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10"
                      title="Drag to resize"
                      style={{ touchAction: 'none' }}
                    >
                      <div className="w-5 h-0.5 rounded-full bg-[oklch(0.5_0.006_90)]" />
                    </div>
                  </div>
                )
              }

              // Task Block
              const dragging = draggingId === b.id
              const conflict = conflictIds.has(b.id)
              const baseBorder = conflict ? 'oklch(0.62 0.2 25)' : 'oklch(0.3 0.006 90)'

              return (
                <div
                  key={b.id}
                  className="group"
                  onClick={() => {
                    if (hasMovedRef.current) {
                      hasMovedRef.current = false
                      return
                    }
                    setDetailBlock(b)
                  }}
                  style={{
                    position: 'absolute',
                    left: `${gutterWidth}px`,
                    right: `${blockRight}px`,
                    top: `${top}px`,
                    height: `${height}px`,
                    borderRadius: '10px',
                    background: dragging ? 'oklch(0.27 0.006 90)' : 'oklch(0.2 0.006 90)',
                    border: `1.5px solid ${baseBorder}`,
                    cursor: 'pointer',
                    transition: dragging ? 'none' : 'background 0.15s',
                    boxShadow: dragging ? '0 18px 30px -10px rgba(0,0,0,0.55)' : 'none',
                    opacity: dragging ? 0.88 : b.completed ? 0.55 : 1,
                    zIndex: dragging ? 20 : 3
                  }}
                >
                  {isSmall ? (
                    /* Compact Single-Line Layout for short duration tasks */
                    <div 
                      onPointerDown={e => startDrag('move', b, e)}
                      className="flex items-center gap-2 w-full h-full px-2.5 overflow-hidden cursor-grab active:cursor-grabbing"
                      style={{ touchAction: 'none' }}
                    >
                      {/* Checkbox */}
                      <button
                        onClick={e => {
                          e.stopPropagation()
                          toggleComplete(b.id)
                        }}
                        style={{
                          width: '16px',
                          height: '16px',
                          borderRadius: '5px',
                          border: `1.5px solid ${b.completed ? accent : 'oklch(0.45 0.006 90)'}`,
                          background: b.completed ? accent : 'transparent',
                          color: accentText,
                          fontSize: '10px',
                          fontWeight: 700,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer',
                          padding: 0,
                          flexShrink: 0
                        }}
                        title={b.completed ? 'Mark pending' : 'Mark completed'}
                      >
                        {b.completed ? '✓' : ''}
                      </button>

                      {/* Title */}
                      <span
                        className="font-medium text-xs truncate flex-1 min-w-0"
                        style={{
                          color: b.completed ? 'oklch(0.5 0.006 90)' : 'oklch(0.94 0.004 90)',
                          textDecoration: b.completed ? 'line-through' : 'none'
                        }}
                      >
                        {b.title}
                      </span>

                      {/* Time Range in JetBrains Mono */}
                      <span
                        style={{ fontFamily: "'JetBrains Mono', monospace" }}
                        className="text-[10px] text-[oklch(0.6_0.006_90)] flex-shrink-0 whitespace-nowrap font-medium"
                      >
                        {timeLabel}
                      </span>

                      {/* Conflict dot */}
                      {conflict && (
                        <div
                          className="w-2 h-2 rounded-full bg-[oklch(0.62_0.2_25)] shadow-[0_0_0_2px_oklch(0.62_0.2_25/0.25)] flex-shrink-0"
                          title="Conflict overlap detected"
                        />
                      )}
                    </div>
                  ) : (
                    /* Full Card Layout for standard duration blocks */
                    <div 
                      onPointerDown={e => startDrag('move', b, e)}
                      className="flex flex-col justify-center h-full px-3 py-1 gap-1 overflow-hidden cursor-grab active:cursor-grabbing"
                      style={{ touchAction: 'none' }}
                    >
                      <div className="flex items-center gap-2">
                        {/* Checkbox */}
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
                          title={b.completed ? 'Mark pending' : 'Mark completed'}
                        >
                          {b.completed ? '✓' : ''}
                        </button>

                        <span
                          className="font-medium text-sm truncate flex-1 min-w-0"
                          style={{
                            color: b.completed ? 'oklch(0.5 0.006 90)' : 'oklch(0.94 0.004 90)',
                            textDecoration: b.completed ? 'line-through' : 'none'
                          }}
                        >
                          {b.title}
                        </span>

                        {conflict && (
                          <div
                            className="w-2 h-2 rounded-full bg-[oklch(0.62_0.2_25)] shadow-[0_0_0_2px_oklch(0.62_0.2_25/0.25)] flex-shrink-0"
                            title="Conflict overlap detected"
                          />
                        )}
                      </div>

                      <div className="flex items-center gap-2 pl-7">
                        <span
                          style={{ fontFamily: "'JetBrains Mono', monospace" }}
                          className="text-[10.5px] text-[oklch(0.56_0.006_90)] tracking-wide flex-shrink-0"
                        >
                          {timeLabel}
                        </span>
                        {b.description && (
                          <span className="text-[11px] text-[oklch(0.52_0.006_90)] truncate">
                            · {b.description}
                          </span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Resize Handle at Bottom */}
                  <div
                    onPointerDown={e => startDrag('resize', b, e)}
                    className="absolute left-1/2 -translate-x-1/2 bottom-0 w-12 h-3 cursor-ns-resize opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center z-10"
                    title="Drag to resize"
                    style={{ touchAction: 'none' }}
                  >
                    <div className="w-5 h-0.5 rounded-full bg-[oklch(0.5_0.006_90)]" />
                  </div>
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
          className="flex-1 flex flex-col items-center gap-0.5 bg-transparent border-none text-[10.5px] font-semibold py-1 cursor-pointer text-[oklch(0.68_0.006_90)] hover:text-white"
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
          onClick={() => setPanel('overview')}
          className="flex-1 flex flex-col items-center gap-0.5 bg-transparent border-none text-[10.5px] font-semibold py-1 cursor-pointer text-[oklch(0.68_0.006_90)]"
        >
          <span className="text-[16px] leading-tight">☰</span>
          Overview
        </button>
      </nav>

      {/* =========================================================================
          4. MODAL: ADD / EDIT BLOCK (RESPONSIVE: SHEET ON MOBILE, CARD ON DESKTOP)
      ========================================================================== */}
      {modal && (
        <div
          onClick={() => setModal(null)}
          className="fixed inset-0 bg-black/60 z-[70] flex items-end md:items-center justify-center animate-fadeIn"
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
              className="w-full text-sm bg-[oklch(0.21_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl p-3 text-[oklch(0.92_0.004_90)] mb-3 outline-none focus:border-[#d9a441] transition-colors"
            />

            {/* Description field */}
            <label className="block text-xs font-medium text-[oklch(0.6_0.006_90)] mb-1.5">
              Description / Notes (optional)
            </label>
            <textarea
              value={modal.draft.description || ''}
              onChange={e => setModal({ ...modal, draft: { ...modal.draft, description: e.target.value } })}
              placeholder="Add details, notes, or links..."
              rows={2}
              className="w-full text-sm bg-[oklch(0.21_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl p-3 text-[oklch(0.92_0.004_90)] mb-4 outline-none focus:border-[#d9a441] transition-colors resize-none placeholder:text-[oklch(0.5_0.006_90)]"
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
          5. BLOCK DETAIL PANEL (RESPONSIVE: BOTTOM SHEET ON MOBILE, DRAWER ON DESKTOP)
      ========================================================================== */}
      {detailBlock && (
        <div
          onClick={() => setDetailBlock(null)}
          className="fixed inset-0 bg-black/50 z-[60] flex items-end md:items-stretch justify-end animate-fadeIn"
        >
          <div
            onClick={e => e.stopPropagation()}
            className="w-full md:w-[400px] max-h-[90dvh] md:max-h-none md:h-full overflow-y-auto bg-[oklch(0.18_0.006_90)] border-t md:border-t-0 md:border-l border-[oklch(0.28_0.006_90)] rounded-t-3xl md:rounded-none p-6 pb-[calc(24px+env(safe-area-inset-bottom,0px))] shadow-2xl animate-sheetUp md:animate-none flex flex-col gap-5"
          >
            {/* Top Bar: Badge & Close */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className="text-xs font-semibold px-2.5 py-1 rounded-lg border uppercase tracking-wider"
                  style={{
                    backgroundColor: detailBlock.type === 'buffer' ? 'oklch(0.24 0.04 70)' : 'oklch(0.24 0.04 220)',
                    borderColor: detailBlock.type === 'buffer' ? 'oklch(0.36 0.06 70)' : 'oklch(0.36 0.06 220)',
                    color: detailBlock.type === 'buffer' ? '#e5c07b' : '#61afef'
                  }}
                >
                  {detailBlock.type === 'buffer' ? 'Buffer' : 'Task'}
                </span>
                <span className="text-xs font-mono text-[oklch(0.6_0.006_90)]">
                  {detailBlock.endMin - detailBlock.startMin} min
                </span>
              </div>
              <button
                onClick={() => setDetailBlock(null)}
                className="w-7 h-7 rounded-lg border border-[oklch(0.3_0.006_90)] bg-[oklch(0.22_0.006_90)] text-[oklch(0.7_0.006_90)] cursor-pointer text-base flex items-center justify-center hover:bg-[oklch(0.26_0.006_90)] transition-colors"
              >
                ×
              </button>
            </div>

            {/* Editable Title */}
            <div>
              <label className="block text-[11px] font-medium text-[oklch(0.55_0.006_90)] uppercase tracking-wider mb-1.5">
                Title
              </label>
              <input
                type="text"
                defaultValue={detailBlock.title}
                key={detailBlock.id + '-title'}
                onBlur={e => handleSaveDetailTitle(detailBlock.id, e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur()
                  }
                }}
                className="w-full text-lg font-semibold bg-[oklch(0.21_0.006_90)] border border-[oklch(0.3_0.006_90)] rounded-xl p-3 text-[oklch(0.95_0.004_90)] outline-none focus:border-[#d9a441] transition-colors"
                placeholder={detailBlock.type === 'buffer' ? 'Buffer label' : 'Task title'}
              />
            </div>

            {/* Time & Schedule Info */}
            <div className="bg-[oklch(0.21_0.006_90)] border border-[oklch(0.28_0.006_90)] rounded-xl p-3.5 flex items-center justify-between">
              <div>
                <span className="block text-[11px] font-medium text-[oklch(0.55_0.006_90)] uppercase tracking-wider mb-1">
                  Scheduled Time
                </span>
                <span
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                  className="text-sm font-semibold text-[oklch(0.92_0.004_90)]"
                >
                  {fmt24(detailBlock.startMin)} – {fmt24(detailBlock.endMin)}
                </span>
              </div>
              <button
                onClick={() => {
                  openEdit(detailBlock)
                  setDetailBlock(null)
                }}
                className="text-xs font-semibold border border-[oklch(0.35_0.006_90)] bg-[oklch(0.24_0.006_90)] text-[oklch(0.85_0.006_90)] rounded-lg py-1.5 px-3 cursor-pointer hover:bg-[oklch(0.28_0.006_90)] transition-colors"
              >
                Change Time
              </button>
            </div>

            {/* Completion Status Toggle (Both Tasks and Buffers!) */}
            <div className="bg-[oklch(0.21_0.006_90)] border border-[oklch(0.28_0.006_90)] rounded-xl p-3.5 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    toggleComplete(detailBlock.id)
                    setDetailBlock(prev => prev ? { ...prev, completed: !prev.completed } : null)
                  }}
                  style={{
                    borderColor: detailBlock.completed ? accent : 'oklch(0.45 0.006 90)',
                    backgroundColor: detailBlock.completed ? accent : 'transparent',
                    color: accentText
                  }}
                  className="w-5 h-5 rounded-md border flex items-center justify-center cursor-pointer p-0 text-xs font-bold transition-colors"
                >
                  {detailBlock.completed ? '✓' : ''}
                </button>
                <div>
                  <span className="text-sm font-medium text-[oklch(0.92_0.004_90)] block">
                    {detailBlock.completed ? 'Completed' : 'Mark as complete'}
                  </span>
                  {detailBlock.completed && detailBlock.completedAt && (
                    <span className="text-[11px] text-[oklch(0.55_0.006_90)] block">
                      Finished at {format(parseISO(detailBlock.completedAt), 'hh:mm a')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Buffer Convert Action (if buffer) */}
            {detailBlock.type === 'buffer' && (
              <div className="bg-[oklch(0.21_0.006_90)] border border-[oklch(0.28_0.006_90)] rounded-xl p-3.5 flex flex-col gap-2">
                <div className="text-xs text-[oklch(0.7_0.006_90)]">
                  Need to turn this flexible buffer into an active task block?
                </div>
                <button
                  onClick={() => {
                    handleConvertBuffer(detailBlock.id)
                    setDetailBlock(prev => prev ? { ...prev, type: 'task', title: prev.title === 'Buffer' ? 'Task' : prev.title } : null)
                  }}
                  style={{ backgroundColor: accent, color: accentText }}
                  className="w-full text-xs font-bold py-2.5 px-3 rounded-xl border-none cursor-pointer flex items-center justify-center gap-2 shadow hover:brightness-105 transition-all"
                >
                  <span>⇄</span>
                  <span>Convert to Task</span>
                </button>
              </div>
            )}

            {/* Description / Notes */}
            <div className="flex-1 flex flex-col">
              <label className="block text-[11px] font-medium text-[oklch(0.55_0.006_90)] uppercase tracking-wider mb-1.5">
                Notes & Description
              </label>
              <textarea
                defaultValue={detailBlock.description || ''}
                key={detailBlock.id + '-desc'}
                onBlur={e => handleSaveDetailDesc(detailBlock.id, e.target.value)}
                placeholder="Add task notes, links, meeting agendas..."
                rows={4}
                className="w-full text-sm bg-[oklch(0.21_0.006_90)] border border-[oklch(0.3_0.006_90)] rounded-xl p-3 text-[oklch(0.92_0.004_90)] outline-none focus:border-[#d9a441] transition-colors resize-y leading-relaxed placeholder:text-[oklch(0.48_0.006_90)]"
              />
            </div>

            {/* Consolidated Actions Footer: Edit & Delete */}
            <div className="pt-3 border-t border-[oklch(0.26_0.006_90)] flex flex-wrap gap-2.5">
              <button
                onClick={() => {
                  handleDeleteBlock(detailBlock.id)
                  setDetailBlock(null)
                }}
                className="flex-[1] min-w-[100px] text-sm font-semibold border border-[oklch(0.35_0.02_25)] bg-[oklch(0.22_0.02_25)] text-[oklch(0.75_0.14_25)] rounded-xl py-3 px-4 cursor-pointer hover:bg-[oklch(0.26_0.02_25)] transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => handleDuplicateBlock(detailBlock)}
                className="flex-[1] min-w-[100px] text-sm font-semibold border border-[oklch(0.32_0.006_90)] bg-[oklch(0.23_0.006_90)] text-[oklch(0.9_0.004_90)] rounded-xl py-3 px-4 cursor-pointer hover:bg-[oklch(0.27_0.006_90)] transition-colors"
              >
                Duplicate
              </button>
              <button
                onClick={() => {
                  openEdit(detailBlock)
                  setDetailBlock(null)
                }}
                className="flex-[1] min-w-[100px] text-sm font-semibold border border-[oklch(0.32_0.006_90)] bg-[oklch(0.23_0.006_90)] text-[oklch(0.9_0.004_90)] rounded-xl py-3 px-4 cursor-pointer hover:bg-[oklch(0.27_0.006_90)] transition-colors"
              >
                Edit Details
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          6. PANELS: SETTINGS & DAY OVERVIEW (RESPONSIVE: SHEET ON MOBILE, DRAWER ON DESKTOP)
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
                {panel === 'settings' ? 'Settings' : 'Day Overview'}
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
                <div className="mb-6 pb-5 border-b border-[oklch(0.26_0.006_90)]">
                  <label className="block text-xs font-medium text-[oklch(0.6_0.006_90)] mb-2">
                    Account
                  </label>
                  <div className="flex items-center gap-3 bg-[oklch(0.21_0.006_90)] border border-[oklch(0.32_0.006_90)] rounded-xl p-3">
                    <div className="w-8 h-8 rounded-full bg-[oklch(0.28_0.006_90)] flex items-center justify-center text-[oklch(0.75_0.006_90)] font-semibold uppercase">
                      {userEmail ? userEmail[0] : '?'}
                    </div>
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-[oklch(0.92_0.004_90)]">{userEmail || 'Not signed in'}</span>
                      <span className="text-[10px] text-[oklch(0.55_0.006_90)]">Logged in</span>
                    </div>
                  </div>
                </div>

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
                    When moving a block pushes it into the next one, should LockIn offer to shift the rest of your day too?
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

            {/* Day Overview content */}
            {panel === 'overview' && (
              <div className="flex flex-col gap-3">
                {blocks.length === 0 ? (
                  <div className="text-center text-[oklch(0.6_0.006_90)] text-sm py-8">
                    No tasks or buffers scheduled for today.
                  </div>
                ) : (
                  blocks
                    .slice()
                    .sort((a, b) => a.startMin - b.startMin)
                    .map((b, index) => (
                      <div
                        key={b.id}
                        onClick={() => setDetailBlock(b)}
                        className="bg-[oklch(0.21_0.006_90)] border border-[oklch(0.3_0.006_90)] rounded-xl p-4 shadow-sm flex flex-col gap-2 cursor-pointer hover:border-[oklch(0.4_0.006_90)] transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); toggleComplete(b.id); }}
                              className={`w-5 h-5 mt-0.5 rounded-md border flex items-center justify-center cursor-pointer transition-colors shrink-0 ${b.completed ? 'bg-[#d9a441] border-[#d9a441] text-[oklch(0.2_0.006_90)]' : 'bg-transparent border-[oklch(0.4_0.006_90)] text-transparent hover:border-[oklch(0.6_0.006_90)]'}`}
                            >
                              {b.completed && (
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              )}
                            </button>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className={`font-semibold text-[oklch(0.94_0.004_90)] text-[15px] leading-tight ${b.completed ? 'line-through opacity-50' : ''}`}>
                                  {b.title}
                                </span>
                                {b.type === 'buffer' && (
                                  <span className="shrink-0 text-[9px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-[oklch(0.26_0.006_90)] text-[oklch(0.75_0.006_90)]">
                                    Buffer
                                  </span>
                                )}
                              </div>
                              <div className="text-xs text-[oklch(0.65_0.006_90)] font-medium mt-1">
                                {fmtTime12h(b.startMin)} - {fmtTime12h(b.endMin)}
                              </div>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-1 shrink-0">
                            <div className="flex flex-col border-l border-[oklch(0.3_0.006_90)] pl-2">
                              <button disabled={index === 0} onClick={(e) => { e.stopPropagation(); handleOverviewReorder(index, 'up'); }} className="h-5 w-6 flex items-center justify-center cursor-pointer text-[oklch(0.6_0.006_90)] hover:text-[oklch(0.9_0.006_90)] disabled:opacity-30 disabled:cursor-default" title="Move Up">
                                ▲
                              </button>
                              <button disabled={index === blocks.length - 1} onClick={(e) => { e.stopPropagation(); handleOverviewReorder(index, 'down'); }} className="h-5 w-6 flex items-center justify-center cursor-pointer text-[oklch(0.6_0.006_90)] hover:text-[oklch(0.9_0.006_90)] disabled:opacity-30 disabled:cursor-default" title="Move Down">
                                ▼
                              </button>
                            </div>
                          </div>
                        </div>
                        {b.description && (
                          <div className={`text-sm text-[oklch(0.75_0.006_90)] mt-2 leading-relaxed ml-8 ${b.completed ? 'opacity-50' : ''}`}>
                            {b.description}
                          </div>
                        )}
                      </div>
                    ))
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          7. SYMMETRIC BIDIRECTIONAL CASCADE PROMPT POPOVER
      ========================================================================== */}
      {cascadePrompt && (
        <div className="fixed left-1/2 -translate-x-1/2 bottom-20 md:bottom-8 z-50 w-[min(380px,94%)] bg-[oklch(0.23_0.01_70)] border border-[oklch(0.38_0.03_70)] rounded-2xl p-4 shadow-2xl animate-fadeIn text-left">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-sm font-bold text-[oklch(0.96_0.004_90)]">
              {cascadePrompt.direction === 'down' ? 'Moved Later' : 'Moved Earlier'}
            </span>
            <span className="font-mono text-xs text-[oklch(0.65_0.006_90)]">
              {Math.abs(cascadePrompt.pushDelta)} min shift
            </span>
          </div>
          <div className="text-xs text-[oklch(0.72_0.006_90)] mb-3 leading-relaxed">
            Choose how you'd like surrounding blocks to respond:
          </div>

          <div className="flex flex-col gap-2">
            {cascadePrompt.pushChain.length > 0 && (
              <button
                onClick={() => applyCascade(cascadePrompt.pushChain, cascadePrompt.pushDelta, blocks, cascadePrompt.snapshot)}
                style={{ backgroundColor: accent, color: accentText }}
                className="w-full text-xs font-bold py-2.5 px-3.5 rounded-xl border-none cursor-pointer flex items-center justify-between shadow hover:brightness-105 active:scale-[0.98] transition-all"
              >
                <span>
                  {cascadePrompt.direction === 'down' ? 'Push following items down' : 'Push preceding items up'}
                </span>
                <span className="font-mono text-[11px] opacity-80">
                  {cascadePrompt.pushChain.length} {cascadePrompt.pushChain.length === 1 ? 'block' : 'blocks'}
                </span>
              </button>
            )}

            {cascadePrompt.fillChain.length > 0 && (
              <button
                onClick={() => applyCascade(cascadePrompt.fillChain, cascadePrompt.fillDelta, blocks, cascadePrompt.snapshot)}
                className="w-full text-xs font-semibold py-2.5 px-3.5 rounded-xl border border-[oklch(0.38_0.01_90)] bg-[oklch(0.28_0.008_90)] text-[oklch(0.92_0.004_90)] cursor-pointer flex items-center justify-between hover:bg-[oklch(0.32_0.008_90)] active:scale-[0.98] transition-all"
              >
                <span>
                  {cascadePrompt.direction === 'down' ? 'Fill gap: shift middle items up' : 'Fill gap: shift middle items down'}
                </span>
                <span className="font-mono text-[11px] opacity-80">
                  {cascadePrompt.fillChain.length} {cascadePrompt.fillChain.length === 1 ? 'block' : 'blocks'}
                </span>
              </button>
            )}

            <button
              onClick={() => {
                if (cascadePrompt.snapshot && cascadePrompt.snapshot[0]) {
                  logUndo('update', { items: [cascadePrompt.snapshot[0]] }, day).catch(console.error)
                }
                setCascadePrompt(null)
              }}
              className="w-full text-xs font-medium py-2 px-3 rounded-xl border border-transparent text-[oklch(0.65_0.006_90)] hover:text-[oklch(0.85_0.006_90)] hover:bg-[oklch(0.26_0.008_90)] transition-colors cursor-pointer text-center"
            >
              Don't cascade (leave surrounding items)
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
