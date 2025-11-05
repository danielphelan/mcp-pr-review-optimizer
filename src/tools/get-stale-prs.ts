/**
 * Tool: get_stale_prs
 * Find PRs that need attention due to age
 */

import { githubClient } from '../github-client.js';
import { config } from '../config.js';
import { StalePR, AgeCategory } from '../types.js';
import { z } from 'zod';

export const GetStalePRsSchema = z.object({
  repositories: z.array(z.string()).optional().describe('List of repository names'),
  age_threshold_hours: z.number().optional().describe('Age threshold in hours, default 72'),
  exclude_draft: z.boolean().optional().describe('Exclude draft PRs, default true'),
  exclude_wip: z.boolean().optional().describe('Exclude WIP PRs, default true'),
});

export type GetStalePRsParams = z.infer<typeof GetStalePRsSchema>;

export async function getStalePRs(params: GetStalePRsParams) {
  const {
    repositories,
    age_threshold_hours = config.thresholds.stalePRHours,
    exclude_draft = true,
    exclude_wip = true,
  } = params;

  // Get all open PRs
  const prs = await githubClient.getOpenPullRequests(repositories, 'open');

  const now = new Date();
  const stalePRs: StalePR[] = [];

  for (const pr of prs) {
    // Apply filters
    if (exclude_draft && pr.draft) continue;
    if (exclude_wip && pr.title.toLowerCase().includes('wip')) continue;

    const createdAt = new Date(pr.created_at);
    const ageMs = now.getTime() - createdAt.getTime();
    const ageHours = ageMs / (1000 * 60 * 60);

    // Check if PR is stale
    if (ageHours >= age_threshold_hours) {
      const lastActivity = new Date(pr.updated_at);
      const reviews = await githubClient.getReviews(pr.repository, pr.number);

      // Determine who we're waiting on
      let waitingOn: 'reviewers' | 'author' = 'reviewers';
      if (reviews.length > 0) {
        const lastReview = reviews[reviews.length - 1];
        const lastReviewDate = new Date(lastReview.submitted_at);
        const lastUpdateDate = new Date(pr.updated_at);

        // If PR was updated after the last review, likely waiting on reviewers
        // Otherwise, waiting on author to respond to feedback
        waitingOn = lastUpdateDate > lastReviewDate ? 'reviewers' : 'author';
      }

      stalePRs.push({
        number: pr.number,
        title: pr.title,
        repository: pr.repository,
        author: pr.author,
        url: pr.url,
        created_at: pr.created_at,
        age_hours: Math.round(ageHours * 10) / 10,
        age_category: getAgeCategory(ageHours),
        last_activity: pr.updated_at,
        waiting_on: waitingOn,
        requested_reviewers: pr.requested_reviewers,
        lines_changed: pr.lines_changed,
        files_changed: pr.files_changed,
      });
    }
  }

  // Sort by age (oldest first)
  stalePRs.sort((a, b) => b.age_hours - a.age_hours);

  // Calculate summary
  const summary = {
    total_stale: stalePRs.length,
    critical: stalePRs.filter(pr => pr.age_category === 'critical').length,
    stale: stalePRs.filter(pr => pr.age_category === 'stale').length,
    average_age_hours: stalePRs.length > 0
      ? Math.round((stalePRs.reduce((sum, pr) => sum + pr.age_hours, 0) / stalePRs.length) * 10) / 10
      : 0,
  };

  return {
    stale_prs: stalePRs,
    summary,
  };
}

function getAgeCategory(ageHours: number): AgeCategory {
  if (ageHours < 24) return 'fresh';
  if (ageHours < 72) return 'aging';
  if (ageHours < 168) return 'stale';
  return 'critical';
}
