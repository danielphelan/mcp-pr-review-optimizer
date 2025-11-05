/**
 * GitHub API client for fetching PR and review data
 */

import { Octokit } from '@octokit/rest';
import { config } from './config.js';
import { PRInfo, ReviewInfo, TimelineEvent } from './types.js';

const logger = {
  info: (msg: string, data?: any) => console.log(`[GitHub Client] ${msg}`, data || ''),
  error: (msg: string, error?: any) => console.error(`[GitHub Client ERROR] ${msg}`, error || ''),
  debug: (msg: string, data?: any) => console.debug(`[GitHub Client DEBUG] ${msg}`, data || ''),
};

export class GitHubClient {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token || config.github.token,
    });
  }

  /**
   * Get pull requests for the configured repositories
   * @param repos - Optional list of repositories to fetch PRs from
   * @param state - PR state to filter by: 'open', 'closed', or 'all' (defaults to 'all')
   */
  async getOpenPullRequests(repos?: string[], state: 'open' | 'closed' | 'all' = 'all'): Promise<PRInfo[]> {
    const repositories = repos || config.github.repos;
    logger.info(`Getting ${state} pull requests for repos: ${repositories?.join(', ') || 'all'}`);

    if (!repositories || repositories.length === 0) {
      logger.info(`No repositories specified, fetching all repos from org: ${config.github.org}`);
      // Fetch all repos in the organization
      const { data: orgRepos } = await this.octokit.repos.listForOrg({
        org: config.github.org,
        type: 'all',
        per_page: 100,
      });
      logger.info(`Found ${orgRepos.length} repositories in organization`);
      return this.fetchPRsForRepos(orgRepos.map(r => r.name), state);
    }

    return this.fetchPRsForRepos(repositories, state);
  }

  /**
   * Fetch PRs for specific repositories
   * @param repoNames - List of repository names to fetch PRs from
   * @param state - PR state to filter by: 'open', 'closed', or 'all' (defaults to 'all')
   */
  private async fetchPRsForRepos(repoNames: string[], state: 'open' | 'closed' | 'all' = 'all'): Promise<PRInfo[]> {
    const allPRs: PRInfo[] = [];
    logger.info(`Fetching ${state} PRs from ${repoNames.length} repositories`);

    for (const repo of repoNames) {
      try {
        logger.debug(`Fetching ${state} PRs from ${config.github.org}/${repo}`);
        const { data: prs } = await this.octokit.pulls.list({
          owner: config.github.org,
          repo,
          state,
          per_page: 100,
        });

        logger.info(`Found ${prs.length} PRs in ${repo}`);

        for (const pr of prs) {
          // Note: pulls.list doesn't include additions/deletions/changed_files
          // We'll fetch these details when needed for specific PRs
          const prInfo: PRInfo = {
            number: pr.number,
            title: pr.title,
            repository: repo,
            author: pr.user?.login || 'unknown',
            url: pr.html_url,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            state: pr.state as 'open' | 'closed' | 'merged',
            draft: pr.draft || false,
            lines_added: 0, // Not available in list API
            lines_deleted: 0, // Not available in list API
            lines_changed: 0, // Not available in list API
            files_changed: 0, // Not available in list API
            requested_reviewers: pr.requested_reviewers?.map(r => r.login) || [],
            assignees: pr.assignees?.map(a => a.login) || [],
            labels: pr.labels?.map(l => l.name) || [],
            merged_at: pr.merged_at || undefined,
          };
          
          // Debug logging for merged PRs
          if (pr.state === 'merged' && pr.merged_at) {
            logger.debug(`Found merged PR #${pr.number} in ${repo}`, {
              merged_at: pr.merged_at,
              created_at: pr.created_at,
            });
          }
          
          allPRs.push(prInfo);
        }
      } catch (error) {
        logger.error(`Error fetching PRs for ${repo}`, error);
      }
    }

    logger.info(`Total PRs fetched: ${allPRs.length}`);
    return allPRs;
  }

  /**
   * Get a specific pull request
   */
  async getPullRequest(repo: string, prNumber: number): Promise<PRInfo | null> {
    try {
      logger.debug(`Getting PR #${prNumber} from ${repo}`);
      const { data: pr } = await this.octokit.pulls.get({
        owner: config.github.org,
        repo,
        pull_number: prNumber,
      });

      logger.info(`Retrieved PR #${prNumber}: "${pr.title}" by ${pr.user?.login}`);
      return {
        number: pr.number,
        title: pr.title,
        repository: repo,
        author: pr.user?.login || 'unknown',
        url: pr.html_url,
        created_at: pr.created_at,
        updated_at: pr.updated_at,
        state: pr.state as 'open' | 'closed',
        draft: pr.draft || false,
        lines_added: pr.additions || 0,
        lines_deleted: pr.deletions || 0,
        lines_changed: (pr.additions || 0) + (pr.deletions || 0),
        files_changed: pr.changed_files || 0,
        requested_reviewers: pr.requested_reviewers?.map(r => r.login) || [],
        assignees: pr.assignees?.map(a => a.login) || [],
        labels: pr.labels?.map(l => l.name) || [],
        merged_at: pr.merged_at || undefined,
      };
    } catch (error) {
      logger.error(`Error fetching PR ${prNumber} from ${repo}`, error);
      return null;
    }
  }

  /**
   * Get reviews for a pull request
   */
  async getReviews(repo: string, prNumber: number): Promise<ReviewInfo[]> {
    try {
      logger.debug(`Fetching reviews for PR #${prNumber} from ${repo}`);
      const { data: reviews } = await this.octokit.pulls.listReviews({
        owner: config.github.org,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });

      logger.info(`Found ${reviews.length} reviews for PR #${prNumber}`, {
        reviewers: reviews.map(r => r.user?.login).filter(Boolean),
      });

      return reviews.map(review => ({
        id: review.id,
        user: review.user?.login || 'unknown',
        state: review.state as any,
        submitted_at: (review.submitted_at || new Date().toISOString()) as string,
        body: review.body || '',
        comments_count: 0, // Will be enhanced with actual comment count
      }));
    } catch (error) {
      logger.error(`Error fetching reviews for PR #${prNumber}`, error);
      return [];
    }
  }

  /**
   * Get files changed in a pull request
   */
  async getFilesChanged(repo: string, prNumber: number): Promise<string[]> {
    try {
      logger.debug(`Fetching changed files for PR #${prNumber} from ${repo}`);
      const { data: files } = await this.octokit.pulls.listFiles({
        owner: config.github.org,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });

      logger.info(`PR #${prNumber} changed ${files.length} files`);
      return files.map(f => f.filename);
    } catch (error) {
      logger.error(`Error fetching files for PR #${prNumber}`, error);
      return [];
    }
  }

  /**
   * Get commit history for a repository (for expertise mapping)
   */
  async getCommits(repo: string, since?: Date): Promise<any[]> {
    try {
      logger.debug(`Fetching commits for ${repo}${since ? ` since ${since.toISOString()}` : ''}`);
      const options: any = {
        owner: config.github.org,
        repo,
        per_page: 100,
      };

      if (since) {
        options.since = since.toISOString();
      }

      const { data: commits } = await this.octokit.repos.listCommits(options);
      logger.info(`Fetched ${commits.length} commits from ${repo}`);
      return commits;
    } catch (error) {
      logger.error(`Error fetching commits for ${repo}`, error);
      return [];
    }
  }

  /**
   * Get timeline events for a pull request
   */
  async getTimeline(repo: string, prNumber: number): Promise<any[]> {
    try {
      logger.debug(`Fetching timeline for PR #${prNumber} from ${repo}`);
      const { data: events } = await this.octokit.issues.listEventsForTimeline({
        owner: config.github.org,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });

      logger.info(`Found ${events.length} timeline events for PR #${prNumber}`);
      return events;
    } catch (error) {
      logger.error(`Error fetching timeline for PR #${prNumber}`, error);
      return [];
    }
  }

  /**
   * Get user information
   */
  async getUser(username: string): Promise<any> {
    try {
      logger.debug(`Fetching user information for ${username}`);
      const { data: user } = await this.octokit.users.getByUsername({
        username,
      });
      logger.info(`Retrieved user ${username}`);
      return user;
    } catch (error) {
      logger.error(`Error fetching user ${username}`, error);
      return null;
    }
  }

  /**
   * Search for commits by author in a specific repository
   */
  async searchCommitsByAuthor(repo: string, author: string, since?: Date): Promise<any[]> {
    try {
      logger.debug(`Searching commits by ${author} in ${repo}${since ? ` since ${since.toISOString()}` : ''}`);
      const options: any = {
        owner: config.github.org,
        repo,
        author,
        per_page: 100,
      };

      if (since) {
        options.since = since.toISOString();
      }

      const { data: commits } = await this.octokit.repos.listCommits(options);
      logger.info(`Found ${commits.length} commits by ${author} in ${repo}`);
      return commits;
    } catch (error) {
      logger.error(`Error searching commits by ${author}`, error);
      return [];
    }
  }
}

// Singleton instance
export const githubClient = new GitHubClient();
