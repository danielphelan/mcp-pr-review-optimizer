/**
 * Tool: suggest_reviewers
 * Recommend optimal reviewers for a PR based on expertise, availability, and speed
 */

import { githubClient } from '../github-client.js';
import { calculateExpertise } from '../expertise.js';
import { calculateReviewerWorkload, calculateAverageResponseTime } from '../availability.js';
import { config } from '../config.js';
import { ReviewerSuggestion } from '../types.js';
import { z } from 'zod';

export const SuggestReviewersSchema = z.object({
  pr_number: z.number().describe('Pull request number'),
  repository: z.string().describe('Repository name'),
  count: z.number().optional().describe('Number of suggestions to return, default 3'),
  prioritize: z.enum(['expertise', 'availability', 'speed', 'balanced']).optional().describe('Prioritization strategy, default balanced'),
});

export type SuggestReviewersParams = z.infer<typeof SuggestReviewersSchema>;

export async function suggestReviewers(params: SuggestReviewersParams) {
  const {
    pr_number,
    repository,
    count = 3,
    prioritize = 'balanced',
  } = params;

  // Get PR details
  const pr = await githubClient.getPullRequest(repository, pr_number);
  if (!pr) {
    throw new Error(`PR #${pr_number} not found in ${repository}`);
  }

  // Get files changed
  const filesChanged = await githubClient.getFilesChanged(repository, pr_number);

  // Get expertise data
  const { fileExpertise, directoryExpertise, languageExpertise } = await calculateExpertise(repository);

  // Get workload data
  const workloadData = await calculateReviewerWorkload(undefined, [repository]);

  // Calculate expertise scores for each potential reviewer
  const reviewerScores = new Map<string, {
    expertiseScore: number;
    availabilityScore: number;
    speedScore: number;
    reasons: string[];
  }>();

  // Get all potential reviewers
  const potentialReviewers = config.github.reviewers || workloadData.map(w => w.reviewer);

  for (const reviewer of potentialReviewers) {
    // Skip the PR author
    if (reviewer === pr.author) continue;

    const scores = {
      expertiseScore: 0,
      availabilityScore: 0,
      speedScore: 0,
      reasons: [] as string[],
    };

    // Calculate expertise score
    let expertiseSum = 0;
    let expertiseCount = 0;

    for (const file of filesChanged) {
      if (fileExpertise[file]?.[reviewer]) {
        expertiseSum += fileExpertise[file][reviewer].score;
        expertiseCount++;

        const exp = fileExpertise[file][reviewer];
        if (exp.score > 0.7) {
          scores.reasons.push(
            `High expertise in ${file} (${exp.commit_count} commits, ${exp.review_count} reviews)`
          );
        } else if (exp.score > 0.4) {
          scores.reasons.push(
            `Moderate expertise in ${file} (${exp.commit_count} commits, ${exp.review_count} reviews)`
          );
        }
      }

      // Check directory expertise
      const directory = file.split('/').slice(0, -1).join('/') || '/';
      if (directoryExpertise[directory]?.[reviewer]) {
        const dirExp = directoryExpertise[directory][reviewer];
        if (dirExp.score > 0.6 && !scores.reasons.some(r => r.includes(directory))) {
          scores.reasons.push(
            `Familiar with ${directory}/ (${dirExp.commit_count} commits, ${dirExp.review_count} reviews)`
          );
        }
      }
    }

    scores.expertiseScore = expertiseCount > 0 ? expertiseSum / expertiseCount : 0;

    // Get availability score
    const workload = workloadData.find(w => w.reviewer === reviewer);
    if (workload) {
      scores.availabilityScore = workload.capacity_score;

      if (workload.status === 'available') {
        scores.reasons.push(`Available (capacity score: ${workload.capacity_score.toFixed(1)})`);
      } else if (workload.status === 'at_capacity') {
        scores.reasons.push(`Currently at capacity (capacity score: ${workload.capacity_score.toFixed(1)})`);
      }
    }

    // Calculate speed score (based on average response time)
    const avgResponseTime = await calculateAverageResponseTime(reviewer, [repository]);
    if (avgResponseTime > 0) {
      // Convert response time to a score (faster = higher score)
      // Assume 2 hours is excellent, 24 hours is poor
      scores.speedScore = Math.max(0, 1 - (avgResponseTime / 24));

      if (avgResponseTime < 4) {
        scores.reasons.push(`Fast response time (avg ${avgResponseTime.toFixed(1)} hours)`);
      } else if (avgResponseTime < 12) {
        scores.reasons.push(`Good response time (avg ${avgResponseTime.toFixed(1)} hours)`);
      }
    } else {
      scores.speedScore = 0.5; // Default if no data
    }

    reviewerScores.set(reviewer, scores);
  }

  // Calculate overall scores based on prioritization
  const suggestions: ReviewerSuggestion[] = [];

  for (const [reviewer, scores] of reviewerScores.entries()) {
    let overallScore = 0;

    switch (prioritize) {
      case 'expertise':
        overallScore = scores.expertiseScore * 0.7 + scores.availabilityScore * 0.2 + scores.speedScore * 0.1;
        break;
      case 'availability':
        overallScore = scores.availabilityScore * 0.7 + scores.expertiseScore * 0.2 + scores.speedScore * 0.1;
        break;
      case 'speed':
        overallScore = scores.speedScore * 0.7 + scores.availabilityScore * 0.2 + scores.expertiseScore * 0.1;
        break;
      case 'balanced':
      default:
        overallScore = scores.expertiseScore * 0.4 + scores.availabilityScore * 0.3 + scores.speedScore * 0.3;
        break;
    }

    const workload = workloadData.find(w => w.reviewer === reviewer);
    const warning = workload?.status === 'at_capacity'
      ? 'High workload - may experience delays'
      : undefined;

    suggestions.push({
      reviewer,
      rank: 0, // Will be set after sorting
      score: Math.round(overallScore * 100) / 100,
      reasons: scores.reasons.length > 0 ? scores.reasons : ['No specific expertise found'],
      expertise_score: Math.round(scores.expertiseScore * 100) / 100,
      availability_score: Math.round(scores.availabilityScore * 100) / 100,
      speed_score: Math.round(scores.speedScore * 100) / 100,
      current_workload: workload ? `${workload.assigned_prs} PRs assigned` : 'Unknown',
      warning,
    });
  }

  // Sort by overall score
  suggestions.sort((a, b) => b.score - a.score);

  // Assign ranks
  suggestions.forEach((s, i) => {
    s.rank = i + 1;
  });

  // Get top N suggestions
  const topSuggestions = suggestions.slice(0, count);

  // Get not recommended (bottom 3 with reasons)
  const notRecommended = suggestions
    .slice(-3)
    .map(s => ({
      reviewer: s.reviewer,
      reasons: s.score < 0.3
        ? ['Low expertise in changed files', s.warning || 'Limited availability'].filter(Boolean)
        : ['Lower match compared to other reviewers'],
    }));

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      repository: pr.repository,
      author: pr.author,
      files_changed: filesChanged,
      languages: [...new Set(filesChanged.map(f => {
        const ext = f.split('.').pop();
        return ext || 'unknown';
      }))],
      size: pr.lines_changed < 100 ? 'small' : pr.lines_changed < 500 ? 'medium' : 'large',
    },
    suggestions: topSuggestions,
    not_recommended: notRecommended,
  };
}
