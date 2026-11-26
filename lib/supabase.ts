import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let cachedClient: SupabaseClient | null = null;

/**
 * Explicit public columns for `public.jobs` so dashboard/list/mutation routes
 * never transmit multi-hundred-KB tailored DOCX/PDF base64 blobs.
 */
export const JOB_PUBLIC_COLUMNS =
  'id, source_id, company, title, url, match_score, summary_hebrew, changes_made, tailored_cv_json, tailoring_diffs_json, status, validation_error, applied_at, created_at';

export function getSupabaseAdmin(): SupabaseClient {
  if (cachedClient) {
    return cachedClient;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase configuration: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.',
    );
  }

  cachedClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cachedClient;
}
