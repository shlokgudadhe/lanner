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

  const searchParams = await props.searchParams;
  const day = searchParams.day || format(new Date(), 'yyyy-MM-dd')
  
  const items = await getItems(day)
  
  const { data: profile } = await supabase
    .from('profiles')
    .select('timezone, cascade_preference')
    .eq('id', data.user.id)
    .single()
    
  const cascadePreference = profile?.cascade_preference || 'ask'
  const timezone = profile?.timezone || 'America/Los_Angeles'

  return (
    <main className="min-h-screen bg-[oklch(0.14_0.006_90)] flex flex-col">
      <TimelineView 
        initialItems={items} 
        day={day} 
        cascadePreference={cascadePreference}
        initialTimezone={timezone}
      />
    </main>
  )
}


