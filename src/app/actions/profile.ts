'use server'

import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

export async function updateProfile(updates: { timezone?: string, cascade_preference?: 'always' | 'ask' | 'never' }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: user.id, ...updates, updated_at: new Date().toISOString() })
    .select()
    .single()

  if (error) {
    console.error('Update profile error:', error)
    throw error
  }
  revalidatePath('/planner')
  return data
}
