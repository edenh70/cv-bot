export type JobStatus = 'pending_review' | 'applied' | 'archived';

export interface TailoredCVExperienceItem {
  role: string;
  company: string;
  period: string;
  bullets: string[];
}

export interface TailoredCVToolboxCategory {
  category: string;
  items: string;
}

export interface TailoredCVExtraSection {
  title: string;
  items: string[];
}

export interface TailoredCV {
  name?: string;
  title?: string;
  contactLine?: string;
  summary: string;
  experience: TailoredCVExperienceItem[];
  toolbox: TailoredCVToolboxCategory[];
  education: string[];
  extraSections?: TailoredCVExtraSection[];
}

export interface MasterCvProfileRecord {
  id: string;
  filename: string;
  raw_text: string;
  structured_json: TailoredCV;
  updated_at: string;
}

export interface SourceRecord {
  id: string;
  name: string;
  url: string;
  is_active: boolean;
  last_scanned_at: string | null;
  created_at: string;
}

export interface JobRecord {
  id: string;
  source_id: string | null;
  company: string;
  title: string;
  url: string;
  match_score: number;
  summary_hebrew: string;
  changes_made: string;
  tailored_cv_json: TailoredCV;
  status: JobStatus;
  applied_at: string | null;
  created_at: string;
}

export interface ExtractedJobCandidate {
  title: string;
  company: string;
  url: string;
}

export interface JobExtractionResult {
  jobs: ExtractedJobCandidate[];
  nextPageUrl: string | null;
}

export interface ScanResultSummary {
  sourcesScanned: number;
  pagesCrawled: number;
  candidatesFound: number;
  jobsAdded: number;
  jobsSkipped: number;
  errors: string[];
  jobs: JobRecord[];
}
