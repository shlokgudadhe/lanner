import { PlannerItem } from '@/types'
import { format, differenceInMinutes, startOfDay } from 'date-fns'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { Trash2, GripVertical } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { useState, useEffect } from 'react'

interface TimelineItemProps {
  item: PlannerItem & { isConflict?: boolean }
  pixelsPerMinute: number
  onToggleComplete: (id: string, currentStatus: boolean) => void
  onDelete: (id: string) => void
}

export function TimelineItem({ item, pixelsPerMinute, onToggleComplete, onDelete }: TimelineItemProps) {
  const [isMounted, setIsMounted] = useState(false)
  useEffect(() => setIsMounted(true), [])

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: item.id,
    data: { type: 'reposition', item },
  })

  const { 
    attributes: resizeAttributes, 
    listeners: resizeListeners, 
    setNodeRef: setResizeRef, 
    transform: resizeTransform, 
    isDragging: isResizing 
  } = useDraggable({
    id: `${item.id}-resize`,
    data: { type: 'resize', item },
  })

  const {
    attributes: reorderAttributes,
    listeners: reorderListeners,
    setNodeRef: setReorderRef,
    transform: reorderTransform,
    isDragging: isReordering
  } = useDraggable({
    id: `${item.id}-reorder`,
    data: { type: 'reorder', item },
  })

  const start = new Date(item.start_time)
  const end = new Date(item.end_time)
  
  const startMinutes = differenceInMinutes(start, startOfDay(start))
  const durationMinutes = differenceInMinutes(end, start)
  
  const top = startMinutes * pixelsPerMinute
  const minHeight = 32
  const baseHeight = Math.max(durationMinutes * pixelsPerMinute, minHeight)
  const height = baseHeight + (resizeTransform?.y || 0)
  const isCompact = height < 60 

  const style = {
    top: `${top}px`,
    height: `${height}px`,
    left: `0%`,
    width: `100%`,
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : (reorderTransform ? `translate3d(0, ${reorderTransform.y}px, 0)` : undefined),
    zIndex: isDragging || isResizing || isReordering ? 50 : item.isConflict ? 10 : 1,
    opacity: isDragging || isReordering ? 0.8 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...(isMounted ? attributes : {})}
      onPointerDown={(e) => {
        if (item.is_buffer) e.stopPropagation()
        else listeners?.onPointerDown?.(e)
      }}
      className={`absolute p-2 md:p-3 group transition-opacity duration-200 overflow-hidden cursor-grab active:cursor-grabbing
        ${item.is_buffer 
          ? 'bg-background bg-hatch border-l-[3px] border-l-muted-foreground border-y border-r border-border shadow-sm' 
          : item.is_completed
            ? 'bg-background border-l-[3px] border-l-muted border-y border-r border-border opacity-50 grayscale'
            : 'bg-background border-l-[3px] border-l-[#0055FF] border-y border-r border-border shadow-sm hover:shadow-md'
        }
        ${item.isConflict ? 'ring-1 ring-red-500 border-red-500' : ''}
      `}
    >
      <div className={`flex items-start justify-between gap-3 h-full relative ${isCompact ? 'flex-row items-center' : 'flex-col md:flex-row'}`}>
        <div className={`flex ${isCompact ? 'items-center flex-row gap-2 md:gap-3' : 'items-start flex-col gap-1'} w-full overflow-hidden`}>
          
          <div className="flex items-center h-full gap-2 md:gap-3 shrink-0">
            {/* Reorder Handle */}
            <div 
              ref={setReorderRef}
              {...reorderListeners}
              {...(isMounted ? reorderAttributes : {})}
              onPointerDown={(e) => {
                e.stopPropagation()
                reorderListeners?.onPointerDown?.(e)
              }}
              className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground transition-colors p-1 -ml-1 md:-ml-2"
            >
              <GripVertical className="h-4 w-4 md:h-5 md:w-5" />
            </div>

            {!item.is_buffer && (
              <Checkbox 
                checked={item.is_completed}
                onCheckedChange={() => onToggleComplete(item.id, item.is_completed)}
                className="h-4 w-4 md:h-5 md:w-5 border-border rounded-none data-[state=checked]:bg-foreground data-[state=checked]:border-foreground"
                onPointerDown={(e) => e.stopPropagation()} 
              />
            )}
          </div>
          
          <div className={`flex-1 min-w-0 flex ${isCompact ? 'flex-row items-center gap-3' : 'flex-col'} justify-center w-full`}>
            <span className={`font-semibold truncate text-sm md:text-base ${item.is_completed ? 'line-through text-muted-foreground' : 'text-foreground'} ${item.is_buffer ? 'text-muted-foreground font-normal italic' : ''}`}>
              {item.title || (item.is_buffer ? 'Buffer' : 'Untitled')}
            </span>
            <span className="text-[10px] md:text-xs font-mono text-muted-foreground tabular-nums tracking-tight shrink-0">
              {format(start, 'HH:mm')} {isCompact ? '-' : '—'} {format(end, 'HH:mm')}
            </span>
          </div>
        </div>

        <div className={`opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ${isCompact ? '' : 'absolute top-0 right-0'}`}>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={(e) => {
              e.stopPropagation()
              onDelete(item.id)
            }}
            onPointerDown={(e) => e.stopPropagation()}
            className="h-6 w-6 md:h-8 md:w-8 text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/50 rounded-none"
          >
            <Trash2 className="h-3 w-3 md:h-4 md:w-4" />
          </Button>
        </div>
      </div>
      
      {/* Resize Handle */}
      <div 
        ref={setResizeRef}
        {...resizeListeners}
        {...(isMounted ? resizeAttributes : {})}
        onPointerDown={(e) => {
          e.stopPropagation()
          resizeListeners?.onPointerDown?.(e)
        }}
        className="absolute bottom-0 left-0 right-0 h-4 md:h-3 cursor-ns-resize flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-20 hover:bg-foreground/5"
      >
        <div className="w-8 h-1 rounded-full bg-border"></div>
      </div>
    </div>
  )
}
