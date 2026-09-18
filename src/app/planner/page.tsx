import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import TimelineView from '@/components/planner/TimelineView'
import { getItems } from '@/app/actions/items'
import { format } from 'date-fns'

export default async function PlannerPage(props: { searchParams: Promise<{ day?: string }> }) {
  const supabase = await createClient()

  const { data, error } = await supabase.auth.getUser()
  if (error || !data?.user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('timezone, cascade_preference')
    .eq('id', data.user.id)
    .single()
    
  const cascadePreference = profile?.cascade_preference || 'ask'
  const timezone = profile?.timezone || 'America/Los_Angeles'

  const searchParams = await props.searchParams;
  let day = searchParams.day
  if (!day) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date())
    const y = parts.find(p => p.type === 'year')?.value
    const m = parts.find(p => p.type === 'month')?.value
    const d = parts.find(p => p.type === 'day')?.value
    day = `${y}-${m}-${d}`
  }
  
  const items = await getItems(day)

  return (
    <main className="fixed inset-0 w-full flex flex-col bg-[oklch(0.16_0.006_90)] text-[oklch(0.92_0.004_90)] overflow-hidden m-0 p-0">
      <TimelineView 
        initialItems={items} 
        day={day} 
        cascadePreference={cascadePreference}
        initialTimezone={timezone}
        userEmail={data.user.email || ''}
      />
    </main>
  )
}



