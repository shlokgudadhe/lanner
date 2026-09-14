'use client'

import { useState, useEffect } from 'react'
import { parseISO, setMinutes, setHours, format } from 'date-fns'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

interface TaskDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  day: string;
  onSave: (data: any) => Promise<void>;
}

export function TaskDialog({ open, onOpenChange, day, onSave }: TaskDialogProps) {
  const [title, setTitle] = useState('')
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')
  const [isBuffer, setIsBuffer] = useState(false)
  const [loading, setLoading] = useState(false)

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setTitle('')
      setStartTime('09:00')
      setEndTime('10:00')
      setIsBuffer(false)
    }
  }, [open])

  const handleSave = async () => {
    setLoading(true)
    const baseDate = parseISO(day)
    
    const [startH, startM] = startTime.split(':').map(Number)
    const startIso = setMinutes(setHours(baseDate, startH), startM).toISOString()
    
    const [endH, endM] = endTime.split(':').map(Number)
    const endIso = setMinutes(setHours(baseDate, endH), endM).toISOString()

    await onSave({
      title,
      start_time: startIso,
      end_time: endIso,
      day: format(baseDate, 'yyyy-MM-dd'),
      is_buffer: isBuffer,
      is_completed: false
    })
    
    setLoading(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Add New Block</DialogTitle>
          <DialogDescription>
            Add a new task or buffer block to your day.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 py-4">
          <div className="flex items-center gap-2 mb-2">
            <Button 
              type="button" 
              variant={!isBuffer ? 'default' : 'outline'} 
              className={!isBuffer ? 'bg-[#0055FF] hover:bg-[#0044CC] text-white rounded-none' : 'rounded-none border-border'}
              onClick={() => setIsBuffer(false)}
            >
              Task
            </Button>
            <Button 
              type="button" 
              variant={isBuffer ? 'default' : 'outline'}
              className={isBuffer ? 'bg-[#0055FF] hover:bg-[#0044CC] text-white rounded-none' : 'rounded-none border-border'}
              onClick={() => setIsBuffer(true)}
            >
              Buffer
            </Button>
          </div>

          {!isBuffer && (
            <div className="grid gap-2">
              <Label htmlFor="title">Title</Label>
              <input 
                id="title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="flex h-10 w-full rounded-none border border-border bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#0055FF] focus:border-[#0055FF] disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="e.g. Design review"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="start">Start Time</Label>
              <input 
                id="start"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="flex h-10 w-full rounded-none border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#0055FF] focus:border-[#0055FF]"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="end">End Time</Label>
              <input 
                id="end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="flex h-10 w-full rounded-none border border-border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#0055FF] focus:border-[#0055FF]"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button disabled={loading} onClick={handleSave} className="bg-[#0055FF] hover:bg-[#0044CC] text-white w-full rounded-none">
            Save Block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
