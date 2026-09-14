export interface Profile {
  id: string;
  timezone: string;
  cascade_preference: 'always' | 'ask' | 'never';
  updated_at: string;
}

export interface PlannerItem {
  id: string;
  user_id: string;
  day: string; // YYYY-MM-DD
  title: string | null;
  start_time: string; // ISO string
  end_time: string; // ISO string
  is_buffer: boolean;
  is_completed: boolean;
  completed_at: string | null;
  sort_order: number;
  is_deleted: boolean;
  created_at: string;
  updated_at: string;
}

export interface UndoLog {
  id: string;
  user_id: string;
  created_at: string;
  action_type: 'move' | 'resize' | 'reorder' | 'cascade' | 'create' | 'delete' | 'complete' | 'uncomplete';
  payload: any;
}
