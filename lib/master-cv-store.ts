import { getDefaultMasterCvTemplate } from './master-cv';
import { getSupabaseAdmin } from './supabase';
import type { MasterCvProfileRecord, TailoredCV } from './types';

const DEFAULT_PROFILE_ID = 'default';

export { getDefaultMasterCvTemplate };

export async function getActiveMasterCv(): Promise<{
  template: TailoredCV;
  profile: MasterCvProfileRecord | null;
}> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('master_cv_profile')
    .select('*')
    .eq('id', DEFAULT_PROFILE_ID)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load master CV profile: ${error.message}`);
  }

  if (!data) {
    return {
      template: getDefaultMasterCvTemplate(),
      profile: null,
    };
  }

  const profile = data as MasterCvProfileRecord;
  return {
    template: profile.structured_json,
    profile,
  };
}

export async function saveMasterCvProfile(params: {
  filename: string;
  rawText: string;
  structured: TailoredCV;
}): Promise<MasterCvProfileRecord> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from('master_cv_profile')
    .upsert(
      {
        id: DEFAULT_PROFILE_ID,
        filename: params.filename,
        raw_text: params.rawText,
        structured_json: params.structured,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' },
    )
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to save master CV profile: ${error.message}`);
  }

  return data as MasterCvProfileRecord;
}

export async function deleteMasterCvProfile(): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from('master_cv_profile')
    .delete()
    .eq('id', DEFAULT_PROFILE_ID);

  if (error) {
    throw new Error(`Failed to reset master CV profile: ${error.message}`);
  }
}
