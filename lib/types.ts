export type JobStatus = 'pending_review' | 'applied' | 'archived' | 'failed_validation';

export type TailoringDiffMap = Record<string, string>;

export interface TailorableBlock {
  id: string;
  section: 'summary' | 'bullet' | 'toolbox';
  originalText: string;
  maxLength: number;
}

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

export interface CvLayoutMeta {
  sectionOrder?: Array<'experience' | 'education' | 'toolbox'>;
  hasSummaryHeading?: boolean;
  accentColor?: string;
  inlineHeaderContact?: boolean;
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
  layout?: CvLayoutMeta;
}

export interface MasterCvProfileRecord {
  id: string;
  filename: string;
  raw_text: string;
  structured_json: TailoredCV;
  original_file_base64?: string | null;
  original_mime_type?: string | null;
  updated_at: string;
}

export interface MasterCvProfilePublic {
  id: string;
  filename: string;
  raw_text: string;
  structured_json: TailoredCV;
  hasOriginalDocx: boolean;
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
  tailoring_diffs_json?: TailoringDiffMap | null;
  status: JobStatus;
  validation_error?: string | null;
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

export type SourceScanStatus = 'matched' | 'no_matches' | 'blocked' | 'error';

export type PaginationStatus =
  | 'single_page'
  | 'switched_pages'
  | 'followed_subpage'
  | 'js_only'
  | 'unknown';

export interface ScannedSourceReport {
  sourceId: string;
  name: string;
  url: string;
  status: SourceScanStatus;
  pagesCrawled: number;
  pagesVisited: string[];
  paginationStatus: PaginationStatus;
  candidatesFound: number;
  jobsAdded: number;
  jobsSkipped: number;
  note?: string;
}

export interface ScanResultSummary {
  sourcesScanned: number;
  pagesCrawled: number;
  candidatesFound: number;
  jobsAdded: number;
  jobsSkipped: number;
  errors: string[];
  jobs: JobRecord[];
  scannedSources: ScannedSourceReport[];
  hasMoreSources?: boolean;
  remainingSources?: number;
}
