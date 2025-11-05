/**
 * Tool: get_review_metrics
 * Analyze review response times and patterns
 */

import { githubClient } from '../github-client.js';
import { calculateReviewerWorkload } from '../availability.js';
import { ReviewerMetrics } from '../types.js';
import { z } from 'zod';

const logger = {
  info: (msg: string, data?: any) => console.log(`[Review Metrics] ${msg}`, data || ''),
  error: (msg: string, error?: any) => console.error(`[Review Metrics ERROR] ${msg}`, error || ''),
  debug: (msg: string, data?: any) => console.debug(`[Review Metrics DEBUG] ${msg}`, data || ''),
};

export const GetReviewMetricsSchema = z.object({
  repositories: z.array(z.string()).optional().describe('List of repository names'),
  start_date: z.string().optional().describe('Start date in ISO format, default 7 days ago'),
  end_date: z.string().optional().describe('End date in ISO format, default today'),
  group_by: z.enum(['reviewer', 'repository', 'author']).optional().describe('Group results by, default reviewer'),
});

export type GetReviewMetricsParams = z.infer<typeof GetReviewMetricsSchema>;

export async function getReviewMetrics(params: GetReviewMetricsParams) {
  const {
    repositories,
    start_date,
    end_date,
    group_by = 'reviewer',
  } = params;

  logger.info(`Starting review metrics analysis`, {
    repositories: repositories || 'all',
    start_date,
    end_date,
    group_by,
  });

  // Parse dates
  const startDate = start_date ? new Date(start_date) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const endDate = end_date ? new Date(end_date) : new Date();
  logger.debug(`Date range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

  // Get all PRs (including closed/merged for historical metrics)
  logger.info(`Fetching pull requests...`);
  const prs = await githubClient.getOpenPullRequests(repositories, 'all');
  logger.info(`Retrieved ${prs.length} total pull requests`);

  // Filter PRs by date range
  // Include PRs that were created OR merged within the range
  const filteredPRs = prs.filter(pr => {
    const createdAt = new Date(pr.created_at);
    const mergedAt = pr.merged_at ? new Date(pr.merged_at) : null;
    
    // Include if created in range OR merged in range
    const createdInRange = createdAt >= startDate && createdAt <= endDate;
    const mergedInRange = mergedAt && mergedAt >= startDate && mergedAt <= endDate;
    
    return createdInRange || mergedInRange;
  });
  logger.info(`Filtered to ${filteredPRs.length} PRs in date range`);

  logger.info(`Grouping by ${group_by}`);
  if (group_by === 'reviewer') {
    return await getMetricsByReviewer(filteredPRs, startDate, endDate);
  } else if (group_by === 'repository') {
    return await getMetricsByRepository(filteredPRs, startDate, endDate);
  } else {
    return await getMetricsByAuthor(filteredPRs, startDate, endDate);
  }
}

async function getMetricsByReviewer(prs: any[], startDate: Date, endDate: Date) {
  logger.info(`Analyzing ${prs.length} PRs to calculate reviewer metrics`);
  const reviewerStats = new Map<string, {
    prsReviewed: number;
    firstResponseTimes: number[];
    completionTimes: number[];
    approvals: number;
    changesRequested: number;
    commentsOnly: number;
    timeToMergeTimes: number[];
  }>();

  // Analyze each PR
  for (const pr of prs) {
    logger.debug(`Processing PR #${pr.number} from ${pr.repository}`);
    const reviews = await githubClient.getReviews(pr.repository, pr.number);
    const prCreatedAt = new Date(pr.created_at);

    for (const review of reviews) {
      const reviewer = review.user;

      if (!reviewerStats.has(reviewer)) {
        reviewerStats.set(reviewer, {
          prsReviewed: 0,
          firstResponseTimes: [],
          completionTimes: [],
          approvals: 0,
          changesRequested: 0,
          commentsOnly: 0,
          timeToMergeTimes: [],
        });
      }

      const stats = reviewerStats.get(reviewer)!;

      // Check if this is the first review from this reviewer
      const reviewerReviews = reviews.filter(r => r.user === reviewer);
      if (reviewerReviews[0].id === review.id) {
        stats.prsReviewed++;

        // Calculate first response time
        const reviewSubmittedAt = new Date(review.submitted_at);
        const responseTimeHours = (reviewSubmittedAt.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);
        stats.firstResponseTimes.push(responseTimeHours);
      }

      // Track review states
      if (review.state === 'APPROVED') {
        stats.approvals++;
      } else if (review.state === 'CHANGES_REQUESTED') {
        stats.changesRequested++;
      } else if (review.state === 'COMMENTED') {
        stats.commentsOnly++;
      }
    }

    // Track time to merge if PR is merged
    if (pr.merged_at) {
      const prCreatedAt = new Date(pr.created_at);
      const mergedAt = new Date(pr.merged_at);
      const timeToMergeHours = (mergedAt.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);
      
      // Add to all reviewers who reviewed this PR
      for (const review of reviews) {
        const reviewer = review.user;
        const stats = reviewerStats.get(reviewer);
        if (stats) {
          stats.timeToMergeTimes.push(timeToMergeHours);
        }
      }
    }
  }

  // Get current workload
  logger.debug(`Fetching current reviewer workload`);
  const workloadData = await calculateReviewerWorkload();
  logger.info(`Retrieved workload data for ${workloadData.length} reviewers`);

  // Build metrics
  logger.info(`Building metrics for ${reviewerStats.size} reviewers`);
  const metricsByReviewer: ReviewerMetrics[] = [];

  for (const [reviewer, stats] of reviewerStats.entries()) {
    const totalReviews = stats.approvals + stats.changesRequested + stats.commentsOnly;
    const workload = workloadData.find(w => w.reviewer === reviewer);

    metricsByReviewer.push({
      reviewer,
      prs_reviewed: stats.prsReviewed,
      avg_first_response_hours: stats.firstResponseTimes.length > 0
        ? Math.round((stats.firstResponseTimes.reduce((sum, t) => sum + t, 0) / stats.firstResponseTimes.length) * 10) / 10
        : 0,
      avg_review_completion_hours: stats.completionTimes.length > 0
        ? Math.round((stats.completionTimes.reduce((sum, t) => sum + t, 0) / stats.completionTimes.length) * 10) / 10
        : 0,
      approval_rate: totalReviews > 0 ? Math.round((stats.approvals / totalReviews) * 100) / 100 : 0,
      request_changes_rate: totalReviews > 0 ? Math.round((stats.changesRequested / totalReviews) * 100) / 100 : 0,
      comment_only_rate: totalReviews > 0 ? Math.round((stats.commentsOnly / totalReviews) * 100) / 100 : 0,
      current_assigned_prs: workload?.assigned_prs || 0,
      avg_time_to_merge_hours: stats.timeToMergeTimes.length > 0
        ? Math.round((stats.timeToMergeTimes.reduce((sum, t) => sum + t, 0) / stats.timeToMergeTimes.length) * 10) / 10
        : 0,
    });
  }

  // Sort by number of PRs reviewed
  metricsByReviewer.sort((a, b) => b.prs_reviewed - a.prs_reviewed);
  logger.info(`Sorted ${metricsByReviewer.length} reviewers by PR count`);

  // Calculate team averages
  logger.debug(`Calculating team averages`);
  const teamAverages = {
    avg_first_response_hours: metricsByReviewer.length > 0
      ? Math.round((metricsByReviewer.reduce((sum, m) => sum + m.avg_first_response_hours, 0) / metricsByReviewer.length) * 10) / 10
      : 0,
    avg_review_completion_hours: metricsByReviewer.length > 0
      ? Math.round((metricsByReviewer.reduce((sum, m) => sum + m.avg_review_completion_hours, 0) / metricsByReviewer.length) * 10) / 10
      : 0,
    approval_rate: metricsByReviewer.length > 0
      ? Math.round((metricsByReviewer.reduce((sum, m) => sum + m.approval_rate, 0) / metricsByReviewer.length) * 100) / 100
      : 0,
    avg_time_to_merge_hours: metricsByReviewer.length > 0
      ? Math.round((metricsByReviewer.reduce((sum, m) => sum + (m.avg_time_to_merge_hours || 0), 0) / metricsByReviewer.length) * 10) / 10
      : 0,
  };

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    metrics_by_reviewer: metricsByReviewer,
    team_averages: teamAverages,
  };
}

async function getMetricsByRepository(prs: any[], startDate: Date, endDate: Date) {
  logger.info(`Analyzing ${prs.length} PRs to calculate repository metrics`);
  
  // Debug: Count PR states and merged status
  const stateCount = prs.reduce((acc, pr) => {
    acc[pr.state] = (acc[pr.state] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
  logger.debug(`PR states in dataset:`, stateCount);
  
  // Debug: Count merged PRs with merged_at
  const mergedWithDate = prs.filter(pr => pr.merged_at).length;
  const mergedCount = prs.filter(pr => pr.state === 'merged' || pr.merged_at).length;
  logger.info(`Merged PRs with merged_at field: ${mergedWithDate}`);
  logger.info(`Merged PRs (by state or merged_at): ${mergedCount}`);
  
  // Debug: Show first few PRs
  if (prs.length > 0) {
    logger.debug(`Sample PR data:`, {
      number: prs[0].number,
      state: prs[0].state,
      merged_at: prs[0].merged_at,
      created_at: prs[0].created_at,
    });
  }
  
  const repoStats = new Map<string, {
    totalPRs: number;
    avgReviewTime: number;
    reviewTimes: number[];
    timeToMergeTimes: number[];
  }>();

  for (const pr of prs) {
    logger.debug(`Processing PR #${pr.number} from ${pr.repository}`);
    const repo = pr.repository;

    if (!repoStats.has(repo)) {
      repoStats.set(repo, {
        totalPRs: 0,
        avgReviewTime: 0,
        reviewTimes: [],
        timeToMergeTimes: [],
      });
    }

    const stats = repoStats.get(repo)!;
    stats.totalPRs++;

    const reviews = await githubClient.getReviews(repo, pr.number);
    if (reviews.length > 0) {
      const firstReview = reviews[0];
      const prCreatedAt = new Date(pr.created_at);
      const firstReviewAt = new Date(firstReview.submitted_at);
      const reviewTimeHours = (firstReviewAt.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);
      stats.reviewTimes.push(reviewTimeHours);
    }

    // Track time to merge if PR is merged
    if (pr.merged_at) {
      const prCreatedAt = new Date(pr.created_at);
      const mergedAt = new Date(pr.merged_at);
      const timeToMergeHours = (mergedAt.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);
      stats.timeToMergeTimes.push(timeToMergeHours);
    }
  }

  const metricsByRepo = Array.from(repoStats.entries()).map(([repo, stats]) => ({
    repository: repo,
    total_prs: stats.totalPRs,
    avg_review_time_hours: stats.reviewTimes.length > 0
      ? Math.round((stats.reviewTimes.reduce((sum, t) => sum + t, 0) / stats.reviewTimes.length) * 10) / 10
      : 0,
    avg_time_to_merge_hours: stats.timeToMergeTimes.length > 0
      ? Math.round((stats.timeToMergeTimes.reduce((sum, t) => sum + t, 0) / stats.timeToMergeTimes.length) * 10) / 10
      : 0,
  }));
  logger.info(`Repository metrics analysis complete`, { repoCount: metricsByRepo.length });

  // Calculate overall average time to merge
  const allMergeTimes: number[] = [];
  for (const stats of repoStats.values()) {
    allMergeTimes.push(...stats.timeToMergeTimes);
  }
  const overallAvgTimeToMerge = allMergeTimes.length > 0
    ? Math.round((allMergeTimes.reduce((sum, t) => sum + t, 0) / allMergeTimes.length) * 10) / 10
    : 0;

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    metrics_by_repository: metricsByRepo,
    overall_avg_time_to_merge_hours: overallAvgTimeToMerge,
  };
}

async function getMetricsByAuthor(prs: any[], startDate: Date, endDate: Date) {
  logger.info(`Analyzing ${prs.length} PRs to calculate author metrics`);
  const authorStats = new Map<string, {
    totalPRs: number;
    avgReviewTime: number;
    reviewTimes: number[];
    timeToMergeTimes: number[];
  }>();

  for (const pr of prs) {
    logger.debug(`Processing PR #${pr.number} by ${pr.author}`);
    const author = pr.author;

    if (!authorStats.has(author)) {
      authorStats.set(author, {
        totalPRs: 0,
        avgReviewTime: 0,
        reviewTimes: [],
        timeToMergeTimes: [],
      });
    }

    const stats = authorStats.get(author)!;
    stats.totalPRs++;

    const reviews = await githubClient.getReviews(pr.repository, pr.number);
    if (reviews.length > 0) {
      const firstReview = reviews[0];
      const prCreatedAt = new Date(pr.created_at);
      const firstReviewAt = new Date(firstReview.submitted_at);
      const reviewTimeHours = (firstReviewAt.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);
      stats.reviewTimes.push(reviewTimeHours);
    }

    // Track time to merge if PR is merged
    if (pr.merged_at) {
      const prCreatedAt = new Date(pr.created_at);
      const mergedAt = new Date(pr.merged_at);
      const timeToMergeHours = (mergedAt.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);
      stats.timeToMergeTimes.push(timeToMergeHours);
    }
  }

  const metricsByAuthor = Array.from(authorStats.entries()).map(([author, stats]) => ({
    author,
    total_prs: stats.totalPRs,
    avg_review_time_hours: stats.reviewTimes.length > 0
      ? Math.round((stats.reviewTimes.reduce((sum, t) => sum + t, 0) / stats.reviewTimes.length) * 10) / 10
      : 0,
    avg_time_to_merge_hours: stats.timeToMergeTimes.length > 0
      ? Math.round((stats.timeToMergeTimes.reduce((sum, t) => sum + t, 0) / stats.timeToMergeTimes.length) * 10) / 10
      : 0,
  }));
  logger.info(`Author metrics analysis complete`, { authorCount: metricsByAuthor.length });

  // Calculate overall average time to merge
  const allMergeTimes: number[] = [];
  for (const stats of authorStats.values()) {
    allMergeTimes.push(...stats.timeToMergeTimes);
  }
  const overallAvgTimeToMerge = allMergeTimes.length > 0
    ? Math.round((allMergeTimes.reduce((sum, t) => sum + t, 0) / allMergeTimes.length) * 10) / 10
    : 0;

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    metrics_by_author: metricsByAuthor,
    overall_avg_time_to_merge_hours: overallAvgTimeToMerge,
  };
}
