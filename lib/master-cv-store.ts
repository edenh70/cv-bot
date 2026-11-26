import { getDefaultMasterCvTemplate } from './master-cv';
import { getSupabaseAdmin } from './supabase';
import type {
  MasterCvProfilePublic,
  MasterCvProfileRecord,
  TailoredCV,
} from './types';

const DEFAULT_PROFILE_ID = 'default';

export { getDefaultMasterCvTemplate };

export function toPublicMasterCvProfile(
  profile: MasterCvProfileRecord | null,
): MasterCvProfilePublic | null {
  if (!profile) return null;
  return {
    id: profile.id,
    filename: profile.filename,
    raw_text: profile.raw_text,
    structured_json: profile.structured_json,
    hasOriginalDocx: Boolean(profile.original_file_base64),
    updated_at: profile.updated_at,
  };
}

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
  originalFileBase64?: string | null;
  originalMimeType?: string | null;
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
        original_file_base64: params.originalFileBase64 ?? null,
        original_mime_type: params.originalMimeType ?? null,
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
