'use server'

import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'
import { PlannerItem } from '@/types'

export async function getItems(day: string): Promise<PlannerItem[]> {
  const supabase = await createClient()
  
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('day', day)
    .eq('is_deleted', false)
    .order('sort_order', { ascending: true })
    
  if (error) {
    console.error('Error fetching items:', error)
    return []
  }
  
  return data as PlannerItem[]
}

export async function createItem(item: Partial<PlannerItem>) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) throw new Error('Not authenticated')

  // Get max sort_order for the day
  const { data: existingItems, error: existingError } = await supabase
    .from('items')
    .select('sort_order')
    .eq('user_id', user.id)
    .eq('day', item.day as string)
    .order('sort_order', { ascending: false })
    .limit(1)
    
  if (existingError) {
    console.error('Fetch existing error:', existingError)
  }
    
  const nextSortOrder = existingItems && existingItems.length > 0 
    ? existingItems[0].sort_order + 1 
    : 1
  
  let insertPayload: any = { ...item, sort_order: nextSortOrder, user_id: user.id }
  let { data, error } = await supabase
    .from('items')
    .insert(insertPayload)
    .select()
    .single()
    
  if (error && error.message?.includes('description')) {
    const { description, ...withoutDesc } = insertPayload
    const fallback = await supabase
      .from('items')
      .insert(withoutDesc)
      .select()
      .single()
    if (!fallback.error) {
      data = { ...fallback.data, description: description || null }
      error = null
    }
  }

  if (error) {
    console.error('Insert error:', error)
    throw new Error(`Supabase Error: ${error.message} - ${error.details} - ${error.hint}`)
  }
  return data as PlannerItem
}

export async function updateItem(id: string, updates: Partial<PlannerItem>) {
  const supabase = await createClient()
  
  let { data, error } = await supabase
    .from('items')
    .update(updates)
    .eq('id', id)
    .select()
    .single()
    
  if (error && error.message?.includes('description')) {
    const { description, ...withoutDesc } = updates
    const fallback = await supabase
      .from('items')
      .update(withoutDesc)
      .eq('id', id)
      .select()
      .single()
    if (!fallback.error) {
      data = { ...fallback.data, description: description || null }
      error = null
    }
  }

  if (error) {
    console.error('Update error:', error)
    throw new Error(`Supabase Error: ${error.message} - ${error.details} - ${error.hint}`)
  }
  return data as PlannerItem
}

export async function deleteItem(id: string) {
  return updateItem(id, { is_deleted: true })
}

export async function cascadeShiftItems(day: string, pivotSortOrder: number, deltaSeconds: number) {
  const supabase = await createClient()
  
  const { error } = await supabase.rpc('cascade_shift_items', {
    p_day: day,
    p_pivot_sort_order: pivotSortOrder,
    p_delta_seconds: deltaSeconds
  })
  
  if (error) throw error
}
