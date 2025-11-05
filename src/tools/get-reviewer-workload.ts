/**
 * Tool: get_reviewer_workload
 * Check current review capacity for reviewers
 */

import { calculateReviewerWorkload } from '../availability.js';
import { config } from '../config.js';
import { z } from 'zod';

export const GetReviewerWorkloadSchema = z.object({
  reviewers: z.array(z.string()).optional().describe('List of GitHub usernames'),
  repositories: z.array(z.string()).optional().describe('List of repository names'),
  include_draft: z.boolean().optional().describe('Include draft PRs, default false'),
});

export type GetReviewerWorkloadParams = z.infer<typeof GetReviewerWorkloadSchema>;

export async function getReviewerWorkload(params: GetReviewerWorkloadParams) {
  const {
    reviewers,
    repositories,
    include_draft = false,
  } = params;

  // Get workload data
  const workloadData = await calculateReviewerWorkload(reviewers, repositories);

  // Calculate team capacity metrics
  const totalAssigned = workloadData.reduce((sum, w) => sum + w.assigned_prs, 0);
  const avgCapacityScore = workloadData.length > 0
    ? workloadData.reduce((sum, w) => sum + w.capacity_score, 0) / workloadData.length
    : 0;

  const bottlenecks = workloadData
    .filter(w => w.status === 'at_capacity')
    .map(w => w.reviewer);

  return {
    workload: workloadData,
    team_capacity: {
      total_assigned: totalAssigned,
      avg_capacity_score: Math.round(avgCapacityScore * 100) / 100,
      bottlenecks,
    },
  };
}
