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
    .select('cascade_preference')
    .eq('id', data.user.id)
    .single()
    
  const cascadePreference = profile?.cascade_preference || 'ask'

  return (
    <main className="h-screen flex flex-col bg-slate-50">
      <TimelineView initialItems={items} day={day} cascadePreference={cascadePreference} />
    </main>
  )
}

