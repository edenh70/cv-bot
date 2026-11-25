export type JobStatus = 'pending_review' | 'applied' | 'archived';

export interface TailoredCVExperienceItem {
  role: string;
  company: string;
  period: string;
  bullets: [string, string, string];
}

export interface TailoredCVToolboxCategory {
  category: string;
  items: string;
}

export interface TailoredCV {
  summary: string;
  experience: [
    TailoredCVExperienceItem,
    TailoredCVExperienceItem,
    TailoredCVExperienceItem,
  ];
  toolbox: [
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
    TailoredCVToolboxCategory,
  ];
  education: string[];
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

export interface ScanResultSummary {
  sourcesScanned: number;
  candidatesFound: number;
  jobsAdded: number;
  jobsSkipped: number;
  errors: string[];
  jobs: JobRecord[];
}
