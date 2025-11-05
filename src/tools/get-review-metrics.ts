/**
 * Tool: get_review_metrics
 * Analyze review response times and patterns
 */

import { githubClient } from '../github-client.js';
import { calculateReviewerWorkload } from '../availability.js';
import { ReviewerMetrics } from '../types.js';
import { z } from 'zod';

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

  // Parse dates
  const startDate = start_date ? new Date(start_date) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const endDate = end_date ? new Date(end_date) : new Date();

  // Get all PRs
  const prs = await githubClient.getOpenPullRequests(repositories);

  // Filter PRs by date range
  const filteredPRs = prs.filter(pr => {
    const createdAt = new Date(pr.created_at);
    return createdAt >= startDate && createdAt <= endDate;
  });

  if (group_by === 'reviewer') {
    return await getMetricsByReviewer(filteredPRs, startDate, endDate);
  } else if (group_by === 'repository') {
    return await getMetricsByRepository(filteredPRs, startDate, endDate);
  } else {
    return await getMetricsByAuthor(filteredPRs, startDate, endDate);
  }
}

async function getMetricsByReviewer(prs: any[], startDate: Date, endDate: Date) {
  const reviewerStats = new Map<string, {
    prsReviewed: number;
    firstResponseTimes: number[];
    completionTimes: number[];
    approvals: number;
    changesRequested: number;
    commentsOnly: number;
  }>();

  // Analyze each PR
  for (const pr of prs) {
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
  }

  // Get current workload
  const workloadData = await calculateReviewerWorkload();

  // Build metrics
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
    });
  }

  // Sort by number of PRs reviewed
  metricsByReviewer.sort((a, b) => b.prs_reviewed - a.prs_reviewed);

  // Calculate team averages
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
  };

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    metrics_by_reviewer: metricsByReviewer,
    team_averages: teamAverages,
  };
}

async function getMetricsByRepository(prs: any[], startDate: Date, endDate: Date) {
  const repoStats = new Map<string, {
    totalPRs: number;
    avgReviewTime: number;
    reviewTimes: number[];
  }>();

  for (const pr of prs) {
    const repo = pr.repository;

    if (!repoStats.has(repo)) {
      repoStats.set(repo, {
        totalPRs: 0,
        avgReviewTime: 0,
        reviewTimes: [],
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
  }

  const metricsByRepo = Array.from(repoStats.entries()).map(([repo, stats]) => ({
    repository: repo,
    total_prs: stats.totalPRs,
    avg_review_time_hours: stats.reviewTimes.length > 0
      ? Math.round((stats.reviewTimes.reduce((sum, t) => sum + t, 0) / stats.reviewTimes.length) * 10) / 10
      : 0,
  }));

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    metrics_by_repository: metricsByRepo,
  };
}

async function getMetricsByAuthor(prs: any[], startDate: Date, endDate: Date) {
  const authorStats = new Map<string, {
    totalPRs: number;
    avgReviewTime: number;
    reviewTimes: number[];
  }>();

  for (const pr of prs) {
    const author = pr.author;

    if (!authorStats.has(author)) {
      authorStats.set(author, {
        totalPRs: 0,
        avgReviewTime: 0,
        reviewTimes: [],
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
  }

  const metricsByAuthor = Array.from(authorStats.entries()).map(([author, stats]) => ({
    author,
    total_prs: stats.totalPRs,
    avg_review_time_hours: stats.reviewTimes.length > 0
      ? Math.round((stats.reviewTimes.reduce((sum, t) => sum + t, 0) / stats.reviewTimes.length) * 10) / 10
      : 0,
  }));

  return {
    period: `${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]}`,
    metrics_by_author: metricsByAuthor,
  };
}
