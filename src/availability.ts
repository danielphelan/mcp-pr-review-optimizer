/**
 * Availability and workload calculation
 * Determines reviewer capacity and current load
 */

import { githubClient } from './github-client.js';
import { config } from './config.js';
import { cache, CACHE_TTL } from './cache.js';
import { ReviewerWorkload } from './types.js';

/**
 * Calculate reviewer workload and availability
 */
export async function calculateReviewerWorkload(
  reviewers?: string[],
  repos?: string[]
): Promise<ReviewerWorkload[]> {
  const cacheKey = `workload:${repos?.join(',') || 'all'}:${reviewers?.join(',') || 'all'}`;
  const cached = cache.get<ReviewerWorkload[]>(cacheKey);
  if (cached) {
    return cached;
  }

  // Get all open PRs
  const prs = await githubClient.getOpenPullRequests(repos);

  // Track metrics per reviewer
  const reviewerStats = new Map<string, {
    assigned: number;
    awaiting: number;
    reviewed7d: number;
  }>();

  // Get the list of reviewers to track
  const trackReviewers = reviewers || config.github.reviewers || [];

  // Initialize stats for tracked reviewers
  for (const reviewer of trackReviewers) {
    reviewerStats.set(reviewer, {
      assigned: 0,
      awaiting: 0,
      reviewed7d: 0,
    });
  }

  // Count assigned PRs
  for (const pr of prs) {
    for (const reviewer of pr.requested_reviewers) {
      if (!reviewerStats.has(reviewer)) {
        reviewerStats.set(reviewer, { assigned: 0, awaiting: 0, reviewed7d: 0 });
      }
      const stats = reviewerStats.get(reviewer)!;
      stats.assigned++;
      stats.awaiting++; // Initially assume all assigned PRs are awaiting review
    }
  }

  // Check review status for each assigned PR
  for (const pr of prs) {
    const reviews = await githubClient.getReviews(pr.repository, pr.number);
    const reviewersDone = new Set(reviews.map(r => r.user));

    for (const reviewer of pr.requested_reviewers) {
      if (reviewersDone.has(reviewer)) {
        const stats = reviewerStats.get(reviewer);
        if (stats) {
          stats.awaiting--;
        }
      }
    }
  }

  // Count reviews in the last 7 days
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  for (const pr of prs) {
    const reviews = await githubClient.getReviews(pr.repository, pr.number);

    for (const review of reviews) {
      const reviewDate = new Date(review.submitted_at);
      if (reviewDate >= sevenDaysAgo) {
        if (!reviewerStats.has(review.user)) {
          reviewerStats.set(review.user, { assigned: 0, awaiting: 0, reviewed7d: 0 });
        }
        const stats = reviewerStats.get(review.user)!;
        stats.reviewed7d++;
      }
    }
  }

  // Calculate workload metrics
  const workloads: ReviewerWorkload[] = [];

  for (const [reviewer, stats] of reviewerStats.entries()) {
    const avgDailyReviews = stats.reviewed7d / 7;

    // Calculate capacity score (0-1, where 1 is fully available)
    // Based on: current assigned PRs (40%), recent review count (30%), awaiting PRs (30%)
    const maxAssigned = config.thresholds.highWorkload;
    const assignedScore = Math.max(0, 1 - stats.assigned / maxAssigned);
    const awaitingScore = Math.max(0, 1 - stats.awaiting / maxAssigned);
    const reviewScore = avgDailyReviews > 3 ? 0.5 : 1 - (avgDailyReviews / 6);

    const capacityScore = (
      assignedScore * 0.4 +
      reviewScore * 0.3 +
      awaitingScore * 0.3
    );

    // Determine status
    let status: ReviewerWorkload['status'];
    if (capacityScore > 0.6) {
      status = 'available';
    } else if (capacityScore > 0.3) {
      status = 'moderate_load';
    } else if (stats.reviewed7d === 0 && stats.assigned === 0) {
      status = 'ooo';
    } else {
      status = 'at_capacity';
    }

    workloads.push({
      reviewer,
      assigned_prs: stats.assigned,
      prs_awaiting_review: stats.awaiting,
      prs_reviewed_last_7_days: stats.reviewed7d,
      avg_daily_reviews: Math.round(avgDailyReviews * 10) / 10,
      status,
      capacity_score: Math.round(capacityScore * 100) / 100,
    });
  }

  // Sort by capacity score (most available first)
  workloads.sort((a, b) => b.capacity_score - a.capacity_score);

  cache.set(cacheKey, workloads, CACHE_TTL.WORKLOAD);
  return workloads;
}

/**
 * Get workload for a specific reviewer
 */
export async function getReviewerWorkload(
  reviewer: string,
  repos?: string[]
): Promise<ReviewerWorkload | null> {
  const workloads = await calculateReviewerWorkload([reviewer], repos);
  return workloads.find(w => w.reviewer === reviewer) || null;
}

/**
 * Calculate average response time for a reviewer
 */
export async function calculateAverageResponseTime(
  reviewer: string,
  repos?: string[]
): Promise<number> {
  const prs = await githubClient.getOpenPullRequests(repos);
  const responseTimes: number[] = [];

  for (const pr of prs) {
    const reviews = await githubClient.getReviews(pr.repository, pr.number);
    const reviewerReview = reviews.find(r => r.user === reviewer);

    if (reviewerReview) {
      const prCreated = new Date(pr.created_at);
      const reviewSubmitted = new Date(reviewerReview.submitted_at);
      const hoursDiff = (reviewSubmitted.getTime() - prCreated.getTime()) / (1000 * 60 * 60);
      responseTimes.push(hoursDiff);
    }
  }

  if (responseTimes.length === 0) {
    return 0;
  }

  return responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length;
}
