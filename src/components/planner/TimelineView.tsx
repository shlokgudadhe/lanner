'use client'

import { PlannerItem } from '@/types'
import { useState, useEffect } from 'react'
import { format, differenceInMinutes, startOfDay, parseISO, isSameDay, addMinutes } from 'date-fns'
import { Button } from '@/components/ui/button'
import { PlusIcon, UndoIcon } from 'lucide-react'
import { TaskDialog } from './TaskDialog'
import { createItem, updateItem, deleteItem, cascadeShiftItems } from '@/app/actions/items'
import { logUndo, performUndo } from '@/app/actions/undo'
import { ThemeToggle } from '@/components/ThemeToggle'
import { TimelineItem } from './TimelineItem'
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, Modifier } from '@dnd-kit/core'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

const PIXELS_PER_MINUTE = 2 // 1 hr = 120px, 15m = 30px, giving a full day ~2880px height
const SNAP_MINUTES = 5
const SNAP_PIXELS = SNAP_MINUTES * PIXELS_PER_MINUTE // 10px

// Conflict detection logic (Phase 2 overlap handling)
function getConflictingItems(items: PlannerItem[]) {
  return items.map(item => {
    const start = new Date(item.start_time).getTime()
    const end = new Date(item.end_time).getTime()
    
    const isConflict = items.some(other => {
      if (other.id === item.id) return false
      const otherStart = new Date(other.start_time).getTime()
      const otherEnd = new Date(other.end_time).getTime()
      return start < otherEnd && end > otherStart
    })
    
    return { ...item, isConflict }
  })
}

function getReorderedItems(items: PlannerItem[], sourceId: string, targetId: string) {
  const source = items.find(i => i.id === sourceId)
  const target = items.find(i => i.id === targetId)
  if (!source || !target || source.id === target.id) return null

  const sourceSort = source.sort_order
  const targetSort = target.sort_order

  const newItems = items.map(item => ({...item}))
  
  newItems.forEach(item => {
    if (sourceSort > targetSort) {
      // Moving UP
      if (item.id === source.id) item.sort_order = targetSort
      else if (item.sort_order >= targetSort && item.sort_order < sourceSort) item.sort_order++
    } else {
      // Moving DOWN
      if (item.id === source.id) item.sort_order = targetSort - 1
      else if (item.sort_order > sourceSort && item.sort_order < targetSort) item.sort_order--
    }
  })
  
  return newItems
}

export default function TimelineView({ initialItems, day, cascadePreference }: { initialItems: PlannerItem[], day: string, cascadePreference: string }) {
  const [items, setItems] = useState<PlannerItem[]>(initialItems)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [now, setNow] = useState(new Date())
  const [cascadePrompt, setCascadePrompt] = useState<{
    isOpen: boolean;
    nItems: number;
    deltaMins: number;
    pivotSortOrder: number;
    snapshot: Partial<PlannerItem>[];
  } | null>(null)

  const router = useRouter()

  const handleUndo = async () => {
    const res = await performUndo()
    if (res.success && res.day) {
      if (res.day !== day) {
        toast('Undo successful', { description: `Reverted action on ${res.day}` })
        router.push(`/planner?day=${res.day}`)
      } else {
        toast('Undo successful')
        router.refresh()
      }
    }
  }

  useEffect(() => {
    setItems(initialItems)
  }, [initialItems])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        handleUndo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [day])

  const executeCascade = async (pivotSortOrder: number, deltaMins: number, snapshot: any[]) => {
    // Optimistic UI for cascade
    setItems(prevItems => prevItems.map(item => {
      if (item.sort_order > pivotSortOrder) {
        return {
          ...item,
          start_time: addMinutes(new Date(item.start_time), deltaMins).toISOString(),
          end_time: addMinutes(new Date(item.end_time), deltaMins).toISOString()
        }
      }
      return item
    }))
    
    try {
      cascadeShiftItems(day, pivotSortOrder, deltaMins * 60).catch(console.error)
      logUndo('update', { items: snapshot }, day).catch(console.error)
    } catch (e) {
      console.error('Failed to cascade:', e)
    }
  }

  // Dynamic magnetic snapping modifier
  const magneticSnapModifier: Modifier = ({ transform, active }) => {
    if (!active) return { ...transform, x: 0 }
    
    const dragType = active.data.current?.type // 'reposition' | 'resize'
    const draggedItem = items.find(i => i.id === active.data.current?.item?.id)
    if (!draggedItem) return { ...transform, x: 0 }
    
    const startMins = differenceInMinutes(draggedItem.start_time, startOfDay(draggedItem.start_time))
    const endMins = differenceInMinutes(draggedItem.end_time, startOfDay(draggedItem.end_time))
    
    const rawDeltaMins = transform.y / PIXELS_PER_MINUTE
    
    const proposedStart = dragType === 'resize' ? startMins : startMins + rawDeltaMins
    const proposedEnd = endMins + rawDeltaMins
    
    // Collect magnetic points
    const magneticPoints: number[] = []
    items.forEach(other => {
      if (other.id === draggedItem.id) return
      magneticPoints.push(differenceInMinutes(other.start_time, startOfDay(other.start_time)))
      magneticPoints.push(differenceInMinutes(other.end_time, startOfDay(other.end_time)))
    })
    
    let bestStartDiff = Infinity
    let bestStartSnap = proposedStart
    
    if (dragType !== 'resize') {
      for (const mp of magneticPoints) {
        if (Math.abs(proposedStart - mp) < bestStartDiff) {
          bestStartDiff = Math.abs(proposedStart - mp)
          bestStartSnap = mp
        }
      }
      const gridSnapStart = Math.round(proposedStart / SNAP_MINUTES) * SNAP_MINUTES
      if (Math.abs(proposedStart - gridSnapStart) < bestStartDiff) {
        bestStartDiff = Math.abs(proposedStart - gridSnapStart)
        bestStartSnap = gridSnapStart
      }
    }
    
    let bestEndDiff = Infinity
    let bestEndSnap = proposedEnd
    
    for (const mp of magneticPoints) {
      if (Math.abs(proposedEnd - mp) < bestEndDiff) {
        bestEndDiff = Math.abs(proposedEnd - mp)
        bestEndSnap = mp
      }
    }
    const gridSnapEnd = Math.round(proposedEnd / SNAP_MINUTES) * SNAP_MINUTES
    if (Math.abs(proposedEnd - gridSnapEnd) < bestEndDiff) {
      bestEndDiff = Math.abs(proposedEnd - gridSnapEnd)
      bestEndSnap = gridSnapEnd
    }
    
    let finalDeltaMins = rawDeltaMins
    if (dragType === 'resize') {
      finalDeltaMins = bestEndSnap - endMins
    } else {
      if (bestStartDiff <= bestEndDiff) {
        finalDeltaMins = bestStartSnap - startMins
      } else {
        finalDeltaMins = bestEndSnap - endMins
      }
    }
    
    return {
      ...transform,
      x: 0,
      y: finalDeltaMins * PIXELS_PER_MINUTE,
    }
  }

  // Configure sensors for drag and drop
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5,
      },
    })
  )

  // Keep the 'now' line updated every minute
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(interval)
  }, [])

  const handleToggleComplete = async (id: string, currentStatus: boolean) => {
    const item = items.find(i => i.id === id)
    if (!item) return
    setItems(items.map(i => i.id === id ? { ...i, is_completed: !currentStatus } : i))
    try {
      const completedAt = !currentStatus ? new Date().toISOString() : null
      
      Promise.all([
        updateItem(id, { is_completed: !currentStatus, completed_at: completedAt }),
        logUndo('update', { items: [{ id, is_completed: currentStatus, completed_at: item.completed_at }] }, day)
      ]).catch(e => {
        setItems(items.map(i => i.id === id ? { ...i, is_completed: currentStatus } : i))
        console.error(e)
      })
    } catch (e) {
      console.error(e)
    }
  }

  const handleDelete = async (id: string) => {
    const previousItems = [...items]
    const item = items.find(i => i.id === id)
    if (!item) return
    setItems(items.filter(i => i.id !== id))
    toast('Task deleted', { action: { label: 'Undo', onClick: () => handleUndo() } })
    
    try {
      Promise.all([
        deleteItem(id),
        logUndo('update', { items: [{ id, is_deleted: false }] }, day)
      ]).catch(e => {
        setItems(previousItems)
        toast.error('Failed to delete task')
        console.error(e)
      })
    } catch (e) {
      console.error(e)
    }
  }

  const handleSaveItem = async (data: Partial<PlannerItem>) => {
    try {
      const newItem = await createItem(data)
      setItems([...items, newItem])
      logUndo('create', { id: newItem.id }, day).catch(console.error)
    } catch (e) {
      console.error(e)
    }
  }

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, delta } = event
    if (delta.y === 0) return

    const dragType = active.data.current?.type // 'reposition' | 'resize'
    const draggedItem = items.find(item => item.id === active.data.current?.item?.id)
    if (!draggedItem) return

    const minutesDelta = Math.round(delta.y / PIXELS_PER_MINUTE)
    if (minutesDelta === 0) return

    if (dragType === 'reorder') {
      const rawNewStart = addMinutes(new Date(draggedItem.start_time), minutesDelta)
      const targetItem = items.find(i => 
        i.id !== draggedItem.id && 
        !i.is_deleted &&
        rawNewStart >= new Date(i.start_time) && 
        rawNewStart < new Date(i.end_time)
      )

      if (targetItem) {
        const snapshot = items.map(i => ({ id: i.id, sort_order: i.sort_order, start_time: i.start_time, end_time: i.end_time }))
        const reorderedItems = getReorderedItems(items, draggedItem.id, targetItem.id)
        if (!reorderedItems) return
        
        const newStart = new Date(targetItem.start_time)
        const duration = differenceInMinutes(new Date(draggedItem.end_time), new Date(draggedItem.start_time))
        const newEnd = addMinutes(newStart, duration)
        
        const updatedA = reorderedItems.find(i => i.id === draggedItem.id)!
        updatedA.start_time = newStart.toISOString()
        updatedA.end_time = newEnd.toISOString()
        
        setItems(reorderedItems)
        
        const nFollowing = reorderedItems.filter(i => i.sort_order > updatedA.sort_order && !i.is_deleted).length
        if (nFollowing > 0) {
          if (cascadePreference === 'always') {
            executeCascade(updatedA.sort_order, duration, snapshot)
          } else if (cascadePreference === 'ask') {
            setCascadePrompt({
              isOpen: true,
              nItems: nFollowing,
              deltaMins: duration,
              pivotSortOrder: updatedA.sort_order,
              snapshot
            })
          }
        } else {
          // No cascade, just log the reorder snapshot
          logUndo('update', { items: snapshot }, day).catch(console.error)
        }

        const updatePromises = reorderedItems.map(i => {
          if (i.id === draggedItem.id) {
             return updateItem(i.id, { 
               sort_order: i.sort_order, 
               start_time: updatedA.start_time, 
               end_time: updatedA.end_time 
             })
          }
          return updateItem(i.id, { sort_order: i.sort_order })
        })

        Promise.all(updatePromises).catch(error => {
          console.error('Failed to sync reorder:', error)
          setItems(items)
        })

        return // Reorder complete
      }
      // If no targetItem, fall through to treat it as a standard reposition
    }

    // If resizing, only end_time changes. If repositioning, both change.
    const newStart = dragType === 'resize' 
      ? new Date(draggedItem.start_time) 
      : addMinutes(new Date(draggedItem.start_time), minutesDelta)
      
    const newEnd = addMinutes(new Date(draggedItem.end_time), minutesDelta)

    // Ensure we don't resize to negative or 0 duration (minimum 15 mins)
    if (dragType === 'resize' && differenceInMinutes(newEnd, newStart) < 15) {
      return
    }

    // Optimistic UI update
    const snapshot = items.map(i => ({ id: i.id, sort_order: i.sort_order, start_time: i.start_time, end_time: i.end_time }))
    
    const updatedItems = items.map(item => {
      if (item.id === draggedItem.id) {
        return {
          ...item,
          start_time: newStart.toISOString(),
          end_time: newEnd.toISOString()
        }
      }
      return item
    })

    setItems(updatedItems)

    const nFollowing = updatedItems.filter(i => i.sort_order > draggedItem.sort_order && !i.is_deleted).length
    if (nFollowing > 0) {
      if (cascadePreference === 'always') {
        executeCascade(draggedItem.sort_order, minutesDelta, snapshot)
      } else if (cascadePreference === 'ask') {
        setCascadePrompt({
          isOpen: true,
          nItems: nFollowing,
          deltaMins: minutesDelta,
          pivotSortOrder: draggedItem.sort_order,
          snapshot
        })
      }
    } else {
      // No cascade, log snapshot
      logUndo('update', { items: snapshot }, day).catch(console.error)
    }

    // Fire network request without blocking UI
    updateItem(draggedItem.id, {
      start_time: newStart.toISOString(),
      end_time: newEnd.toISOString()
    }).catch(error => {
      console.error('Failed to update time:', error)
      setItems(items)
    })
  }

  const hours = Array.from({ length: 24 }).map((_, i) => i)
  const targetDate = parseISO(day)
  const isToday = isSameDay(targetDate, now)
  const nowMinutes = differenceInMinutes(now, startOfDay(now))
  const nowTop = nowMinutes * PIXELS_PER_MINUTE

  const positionedItems = getConflictingItems(items)

  return (
    <DndContext sensors={sensors} modifiers={[magneticSnapModifier]} onDragEnd={handleDragEnd}>
      <div className="flex flex-col h-full bg-background transition-colors duration-200 font-sans">
        {/* Header */}
        <header className="flex justify-between items-end px-6 md:px-12 py-8 max-w-6xl mx-auto w-full border-b border-border transition-colors duration-200">
          <div>
            <h2 className="text-sm font-mono text-muted-foreground uppercase tracking-widest mb-1">
              {isToday ? 'Today' : format(targetDate, 'MMMM yyyy')}
            </h2>
            <h1 className="text-4xl md:text-5xl font-bold text-foreground tracking-tight">
              {format(targetDate, 'EEEE, do')}
            </h1>
          </div>
          <div className="flex items-center gap-4">
            <ThemeToggle />
            <Button variant="outline" onClick={handleUndo} className="hidden md:flex rounded-none" title="Undo (Ctrl+Z)">
              <UndoIcon className="w-4 h-4 md:mr-2" />
              <span className="hidden md:inline">Undo</span>
            </Button>
            <form action="/auth/signout" method="post">
              <Button variant="ghost" className="text-muted-foreground hover:text-foreground font-medium hidden md:flex transition-colors rounded-none">
                Sign out
              </Button>
            </form>
            <Button 
              onClick={() => setDialogOpen(true)} 
              className="bg-[#0055FF] text-white hover:bg-[#0044CC] rounded-none px-6 py-6 font-medium tracking-wide shadow-[0_4px_14px_0_rgba(0,85,255,0.39)] transition-all hover:shadow-[0_6px_20px_rgba(0,85,255,0.23)] hover:-translate-y-[1px]"
            >
              <PlusIcon className="w-5 h-5 mr-2" />
              New Block
            </Button>
          </div>
        </header>

        {/* Timeline Area */}
        <div className="flex-1 overflow-y-auto relative max-w-6xl mx-auto w-full px-6 md:px-12 py-8 pb-32">
          <div className="relative flex" style={{ height: `${24 * 60 * PIXELS_PER_MINUTE}px` }}>
            
            {/* Left Rail (Times) */}
            <div className="w-20 flex-shrink-0 relative border-r border-border/80">
              {hours.map(hour => (
                <div 
                  key={hour} 
                  className="absolute w-full pr-4 text-right"
                  style={{ top: `${hour * 60 * PIXELS_PER_MINUTE}px`, transform: 'translateY(-50%)' }}
                >
                  <span className="text-sm font-mono text-muted-foreground opacity-70">
                    {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                  </span>
                </div>
              ))}
              
              {/* Current Time (Now) Label */}
              {isToday && (
                <div 
                  className="absolute w-full pr-3 text-right z-20"
                  style={{ top: `${nowTop}px`, transform: 'translateY(-50%)' }}
                >
                  <span className="text-[11px] font-mono font-bold text-[#0055FF] bg-blue-50 dark:bg-blue-950 px-1.5 py-0.5 rounded shadow-sm">
                    {format(now, 'HH:mm')}
                  </span>
                </div>
              )}
            </div>

            {/* Right Lane (Blocks & Grid) */}
            <div className="flex-1 relative">
              {/* Hour Grid Lines */}
              {hours.map(hour => (
                <div 
                  key={hour} 
                  className="absolute w-full border-t border-border opacity-40 pointer-events-none"
                  style={{ top: `${hour * 60 * PIXELS_PER_MINUTE}px` }}
                ></div>
              ))}

              {/* Current Time (Now) Line */}
              {isToday && (
                <div 
                  className="absolute w-full flex items-center z-20 pointer-events-none"
                  style={{ top: `${nowTop}px`, transform: 'translateY(-50%)' }}
                >
                  <div className="w-2 h-2 rounded-full bg-[#0055FF] -ml-1"></div>
                  <div className="flex-1 border-t-2 border-[#0055FF] border-dashed opacity-60"></div>
                </div>
              )}

              {/* Rendered Items */}
              {positionedItems.map((item) => (
                <TimelineItem 
                  key={item.id} 
                  item={item} 
                  pixelsPerMinute={PIXELS_PER_MINUTE} 
                  onToggleComplete={handleToggleComplete}
                  onDelete={handleDelete}
                />
              ))}
            </div>

          </div>
        </div>
        
        <TaskDialog 
          open={dialogOpen} 
          onOpenChange={setDialogOpen} 
          day={day}
          onSave={handleSaveItem}
        />

        {cascadePrompt?.isOpen && (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-popover text-popover-foreground border border-border shadow-lg p-4 rounded-lg z-50 flex items-center gap-4 animate-in slide-in-from-bottom-5">
            <span className="text-sm font-medium">
              Shift {cascadePrompt.nItems} following item{cascadePrompt.nItems > 1 ? 's' : ''} by {cascadePrompt.deltaMins} mins?
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setCascadePrompt(null)}>No</Button>
              <Button size="sm" onClick={() => {
                executeCascade(cascadePrompt.pivotSortOrder, cascadePrompt.deltaMins, cascadePrompt.snapshot)
                setCascadePrompt(null)
              }}>Yes</Button>
            </div>
          </div>
        )}
      </div>
    </DndContext>
  )
}
