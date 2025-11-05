/**
 * Core type definitions for the PR Review Optimizer MCP Server
 */

export interface PRInfo {
  number: number;
  title: string;
  repository: string;
  author: string;
  url: string;
  created_at: string;
  updated_at: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  lines_added: number;
  lines_deleted: number;
  lines_changed: number;
  files_changed: number;
  requested_reviewers: string[];
  assignees: string[];
  labels: string[];
}

export interface ReviewInfo {
  id: number;
  user: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  submitted_at: string;
  body: string;
  comments_count: number;
}

export interface TimelineEvent {
  event: 'created' | 'review_requested' | 'first_review' | 'review' | 'changes_pushed' | 'approved' | 'merged' | 'closed';
  timestamp: string;
  actor: string;
  elapsed_hours: number;
  details?: any;
}

export interface PRMetrics {
  age_hours: number;
  time_to_first_review_hours: number | null;
  total_reviews: number;
  total_review_rounds: number;
  time_waiting_on_reviewers_hours: number;
  time_waiting_on_author_hours: number;
  currently_waiting_on: 'reviewers' | 'author' | 'ci' | 'merge';
}

export interface StalePR {
  number: number;
  title: string;
  repository: string;
  author: string;
  url: string;
  created_at: string;
  age_hours: number;
  age_category: 'fresh' | 'aging' | 'stale' | 'critical';
  last_activity: string;
  waiting_on: 'reviewers' | 'author';
  requested_reviewers: string[];
  lines_changed: number;
  files_changed: number;
}

export interface ReviewerMetrics {
  reviewer: string;
  prs_reviewed: number;
  avg_first_response_hours: number;
  avg_review_completion_hours: number;
  approval_rate: number;
  request_changes_rate: number;
  comment_only_rate: number;
  current_assigned_prs: number;
}

export interface ReviewerWorkload {
  reviewer: string;
  assigned_prs: number;
  prs_awaiting_review: number;
  prs_reviewed_last_7_days: number;
  avg_daily_reviews: number;
  status: 'available' | 'moderate_load' | 'at_capacity' | 'ooo';
  capacity_score: number;
}

export interface ExpertiseScore {
  file_path?: string;
  directory?: string;
  language?: string;
  score: number;
  commit_count: number;
  review_count: number;
  last_activity: string;
}

export interface ReviewerSuggestion {
  reviewer: string;
  rank: number;
  score: number;
  reasons: string[];
  expertise_score: number;
  availability_score: number;
  speed_score: number;
  current_workload: string;
  warning?: string;
}

export interface Bottleneck {
  type: 'reviewer' | 'repository' | 'pr_size' | 'team_capacity';
  name: string;
  severity: 'low' | 'medium' | 'high';
  details: {
    [key: string]: any;
  };
  recommendation?: string;
}

export interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

export interface Config {
  github: {
    token: string;
    org: string;
    repos?: string[];
    reviewers?: string[];
  };
  thresholds: {
    stalePRHours: number;
    criticalPRHours: number;
    highWorkload: number;
  };
  expertise: {
    commitWeight: number;
    reviewWeight: number;
    lookbackDays: number;
  };
  server: {
    port: number;
    host: string;
  };
}

export type AgeCategory = 'fresh' | 'aging' | 'stale' | 'critical';

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';

export type WaitingOn = 'reviewers' | 'author' | 'ci' | 'merge';
