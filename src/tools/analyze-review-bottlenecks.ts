/**
 * Tool: analyze_review_bottlenecks
 * Identify where reviews are getting stuck
 */

import { githubClient } from '../github-client.js';
import { calculateReviewerWorkload } from '../availability.js';
import { config } from '../config.js';
import { Bottleneck } from '../types.js';
import { z } from 'zod';

export const AnalyzeReviewBottlenecksSchema = z.object({
  repositories: z.array(z.string()).optional().describe('List of repository names'),
  days_back: z.number().optional().describe('Number of days to analyze, default 14'),
  min_prs: z.number().optional().describe('Minimum PRs to analyze, default 5'),
});

export type AnalyzeReviewBottlenecksParams = z.infer<typeof AnalyzeReviewBottlenecksSchema>;

export async function analyzeReviewBottlenecks(params: AnalyzeReviewBottlenecksParams) {
  const {
    repositories,
    days_back = 14,
    min_prs = 5,
  } = params;

  // Get PRs
  const prs = await githubClient.getOpenPullRequests(repositories);

  // Filter PRs by date
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days_back);

  const recentPRs = prs.filter(pr => {
    const createdAt = new Date(pr.created_at);
    return createdAt >= cutoffDate;
  });

  if (recentPRs.length < min_prs) {
    return {
      period: `Last ${days_back} days`,
      bottlenecks: [],
      trends: {
        avg_review_time_increasing: false,
        review_requests_increasing: false,
        team_capacity_decreasing: false,
      },
      recommendations: ['Not enough data to analyze bottlenecks (minimum 5 PRs required)'],
    };
  }

  const bottlenecks: Bottleneck[] = [];

  // Analyze reviewer bottlenecks
  const workloadData = await calculateReviewerWorkload(undefined, repositories);

  for (const workload of workloadData) {
    if (workload.status === 'at_capacity' && workload.assigned_prs >= config.thresholds.highWorkload) {
      // Calculate average response time
      let totalResponseTime = 0;
      let responseCount = 0;

      for (const pr of recentPRs) {
        if (pr.requested_reviewers.includes(workload.reviewer)) {
          const reviews = await githubClient.getReviews(pr.repository, pr.number);
          const reviewerReview = reviews.find(r => r.user === workload.reviewer);

          if (reviewerReview) {
            const prCreated = new Date(pr.created_at);
            const reviewSubmitted = new Date(reviewerReview.submitted_at);
            const hours = (reviewSubmitted.getTime() - prCreated.getTime()) / (1000 * 60 * 60);
            totalResponseTime += hours;
            responseCount++;
          }
        }
      }

      const avgResponseTime = responseCount > 0 ? totalResponseTime / responseCount : 0;
      const prsOverdue = recentPRs.filter(pr =>
        pr.requested_reviewers.includes(workload.reviewer) &&
        (new Date().getTime() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60) > 72
      ).length;

      bottlenecks.push({
        type: 'reviewer',
        name: workload.reviewer,
        severity: workload.capacity_score < 0.2 ? 'high' : 'medium',
        details: {
          prs_assigned: workload.assigned_prs,
          avg_first_response_hours: Math.round(avgResponseTime * 10) / 10,
          prs_overdue: prsOverdue,
          recommendation: 'Redistribute load or add more reviewers',
        },
      });
    }
  }

  // Analyze repository bottlenecks
  const repoStats = new Map<string, {
    totalPRs: number;
    reviewTimes: number[];
    largePRs: number;
    oldPRs: number;
  }>();

  for (const pr of recentPRs) {
    if (!repoStats.has(pr.repository)) {
      repoStats.set(pr.repository, {
        totalPRs: 0,
        reviewTimes: [],
        largePRs: 0,
        oldPRs: 0,
      });
    }

    const stats = repoStats.get(pr.repository)!;
    stats.totalPRs++;

    if (pr.lines_changed > 500) {
      stats.largePRs++;
    }

    const ageHours = (new Date().getTime() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60);
    if (ageHours > 168) {
      stats.oldPRs++;
    }

    // Get review time
    const reviews = await githubClient.getReviews(pr.repository, pr.number);
    if (reviews.length > 0) {
      const firstReview = reviews[0];
      const reviewTime = (new Date(firstReview.submitted_at).getTime() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60);
      stats.reviewTimes.push(reviewTime);
    }
  }

  for (const [repo, stats] of repoStats.entries()) {
    const avgReviewTime = stats.reviewTimes.length > 0
      ? stats.reviewTimes.reduce((sum, t) => sum + t, 0) / stats.reviewTimes.length
      : 0;

    if (avgReviewTime > 48 || stats.oldPRs > 5) {
      const avgPRSize = recentPRs
        .filter(pr => pr.repository === repo)
        .reduce((sum, pr) => sum + pr.lines_changed, 0) / stats.totalPRs;

      bottlenecks.push({
        type: 'repository',
        name: repo,
        severity: avgReviewTime > 72 ? 'high' : 'medium',
        details: {
          avg_review_time_hours: Math.round(avgReviewTime * 10) / 10,
          prs_open_over_7_days: stats.oldPRs,
          common_issues: stats.largePRs > stats.totalPRs * 0.3
            ? `Large PRs (avg ${Math.round(avgPRSize)} lines), complex changes`
            : 'Complex changes, insufficient reviewers',
          recommendation: stats.largePRs > stats.totalPRs * 0.3
            ? 'Encourage smaller PRs, add automation'
            : 'Add more reviewers or improve review guidelines',
        },
      });
    }
  }

  // Analyze PR size bottlenecks
  const largePRs = recentPRs.filter(pr => pr.lines_changed > 500);
  if (largePRs.length > 0) {
    const largePRReviewTimes: number[] = [];

    for (const pr of largePRs) {
      const reviews = await githubClient.getReviews(pr.repository, pr.number);
      if (reviews.length > 0) {
        const firstReview = reviews[0];
        const reviewTime = (new Date(firstReview.submitted_at).getTime() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60);
        largePRReviewTimes.push(reviewTime);
      }
    }

    const avgLargePRReviewTime = largePRReviewTimes.length > 0
      ? largePRReviewTimes.reduce((sum, t) => sum + t, 0) / largePRReviewTimes.length
      : 0;

    if (avgLargePRReviewTime > 48) {
      bottlenecks.push({
        type: 'pr_size',
        name: 'large_prs',
        severity: avgLargePRReviewTime > 72 ? 'high' : 'medium',
        details: {
          prs_over_500_lines: largePRs.length,
          avg_review_time_hours: Math.round(avgLargePRReviewTime * 10) / 10,
          recommendation: 'Set guidelines for PR size limits (max 400 lines recommended)',
        },
      });
    }
  }

  // Sort bottlenecks by severity
  bottlenecks.sort((a, b) => {
    const severityOrder = { high: 0, medium: 1, low: 2 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  // Calculate trends (simplified - would need historical data for real trends)
  const avgReviewTime = recentPRs.reduce((sum, pr) => {
    const reviews = pr.requested_reviewers.length;
    return sum + (reviews > 0 ? 24 : 0); // Simplified
  }, 0) / recentPRs.length;

  const trends = {
    avg_review_time_increasing: avgReviewTime > 18,
    review_requests_increasing: recentPRs.length > 20,
    team_capacity_decreasing: workloadData.filter(w => w.status === 'at_capacity').length > workloadData.length * 0.3,
  };

  // Generate recommendations
  const recommendations: string[] = [];

  const overloadedReviewers = bottlenecks.filter(b => b.type === 'reviewer' && b.severity === 'high');
  if (overloadedReviewers.length > 0) {
    const availableReviewers = workloadData.filter(w => w.status === 'available').map(w => w.reviewer);
    if (availableReviewers.length > 0) {
      recommendations.push(
        `Redistribute ${Math.ceil(overloadedReviewers.length * 2)} PRs from ${overloadedReviewers.map(b => b.name).join(', ')} to ${availableReviewers.slice(0, 2).join(' and ')}`
      );
    } else {
      recommendations.push('Consider adding more reviewers to the team - current capacity is insufficient');
    }
  }

  if (largePRs.length > recentPRs.length * 0.3) {
    recommendations.push('Consider splitting large PRs (>500 lines) into smaller chunks');
  }

  const problemRepos = bottlenecks.filter(b => b.type === 'repository');
  if (problemRepos.length > 0) {
    recommendations.push(`Add more reviewers to ${problemRepos.map(b => b.name).join(', ')} repository`);
  }

  if (recommendations.length === 0) {
    recommendations.push('No significant bottlenecks detected - team is performing well!');
  }

  return {
    period: `Last ${days_back} days`,
    bottlenecks,
    trends,
    recommendations,
  };
}
