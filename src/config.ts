/**
 * Configuration management for the PR Review Optimizer
 */

import { config as loadEnv } from 'dotenv';
import { Config } from './types.js';

// Load environment variables
loadEnv();

/**
 * Load and validate configuration from environment variables
 */
export function loadConfig(): Config {
  const githubToken = process.env.GITHUB_TOKEN;
  const githubOrg = process.env.GITHUB_ORG;

  if (!githubToken) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }

  if (!githubOrg) {
    throw new Error('GITHUB_ORG environment variable is required');
  }

  const repos = process.env.GITHUB_REPOS
    ? process.env.GITHUB_REPOS.split(',').map(r => r.trim())
    : undefined;

  const reviewers = process.env.GITHUB_REVIEWERS
    ? process.env.GITHUB_REVIEWERS.split(',').map(r => r.trim())
    : undefined;

  return {
    github: {
      token: githubToken,
      org: githubOrg,
      repos,
      reviewers,
    },
    thresholds: {
      stalePRHours: parseInt(process.env.STALE_PR_THRESHOLD_HOURS || '72', 10),
      criticalPRHours: parseInt(process.env.CRITICAL_PR_THRESHOLD_HOURS || '168', 10),
      highWorkload: parseInt(process.env.HIGH_WORKLOAD_THRESHOLD || '6', 10),
    },
    expertise: {
      commitWeight: parseFloat(process.env.EXPERTISE_COMMIT_WEIGHT || '0.6'),
      reviewWeight: parseFloat(process.env.EXPERTISE_REVIEW_WEIGHT || '0.4'),
      lookbackDays: parseInt(process.env.EXPERTISE_LOOKBACK_DAYS || '90', 10),
    },
    server: {
      port: parseInt(process.env.PORT || '3000', 10),
      host: process.env.HOST || 'localhost',
    },
  };
}

export const config = loadConfig();
