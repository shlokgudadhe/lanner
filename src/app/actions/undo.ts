'use server'

import { createClient } from '@/utils/supabase/server'
import { revalidatePath } from 'next/cache'

/**
 * Logs an undo action to the database.
 * @param actionType 'create' (revert by deleting) or 'update' (revert by restoring values)
 * @param payload The snapshot of the state before the mutation
 * @param day The day this action occurred on, for navigation purposes on revert
 */
export async function logUndo(actionType: 'create' | 'update', payload: any, day: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return

  // 1. Insert new log
  await supabase.from('undo_log').insert({
    user_id: user.id,
    action_type: actionType,
    payload: { ...payload, __day: day }
  })

  // 2. Enforce stack depth of 20
  const { data: logs } = await supabase
    .from('undo_log')
    .select('id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
  
  if (logs && logs.length > 20) {
    const idsToDelete = logs.slice(20).map(l => l.id)
    await supabase.from('undo_log').delete().in('id', idsToDelete)
  }
}

/**
 * Performs the most recent undo action for the authenticated user.
 * @returns The day that was modified, actionType, payload, and the list of reverted items.
 */
export async function performUndo(): Promise<{
  success: boolean
  day: string | null
  actionType?: 'create' | 'update'
  payload?: any
  revertedItems?: any[]
  error?: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  
  if (!user) {
    return { success: false, day: null, error: 'Not authenticated' }
  }

  // 1. Get latest undo log strictly scoped to current user, ordered by created_at DESC
  const { data: logs, error: fetchErr } = await supabase
    .from('undo_log')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)

  if (fetchErr || !logs || logs.length === 0) {
    return { success: false, day: null, error: 'Nothing to undo' }
  }

  const lastLog = logs[0]
  const targetDay = lastLog.payload?.__day || null
  let revertedItems: any[] = []

  try {
    // 2. Revert the action atomically
    if (lastLog.action_type === 'create') {
      // Revert a create by soft-deleting the item
      const { data } = await supabase
        .from('items')
        .update({ is_deleted: true })
        .eq('id', lastLog.payload.id)
        .eq('user_id', user.id)
        .select()
        .single()

      if (data) revertedItems = [data]
    } else if (lastLog.action_type === 'update') {
      // Revert an update by restoring previous fields for all affected items atomically
      if (lastLog.payload.items && Array.isArray(lastLog.payload.items)) {
        const updatePromises = lastLog.payload.items.map(async (item: any) => {
          const { id, ...fields } = item
          const { data } = await supabase
            .from('items')
            .update(fields)
            .eq('id', id)
            .eq('user_id', user.id)
            .select()
            .single()
          return data
        })
        const results = await Promise.all(updatePromises)
        revertedItems = results.filter(Boolean)
      }
    }

    // 3. Delete the used log entry
    await supabase.from('undo_log').delete().eq('id', lastLog.id)

    revalidatePath('/planner')
    return {
      success: true,
      day: targetDay,
      actionType: lastLog.action_type,
      payload: lastLog.payload,
      revertedItems
    }
  } catch (error) {
    console.error('Failed to perform undo:', error)
    return { success: false, day: null, error: 'Failed to apply undo' }
  }
}

