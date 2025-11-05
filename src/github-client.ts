/**
 * GitHub API client for fetching PR and review data
 */

import { Octokit } from '@octokit/rest';
import { config } from './config.js';
import { PRInfo, ReviewInfo, TimelineEvent } from './types.js';

export class GitHubClient {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token || config.github.token,
    });
  }

  /**
   * Get all open pull requests for the configured repositories
   */
  async getOpenPullRequests(repos?: string[]): Promise<PRInfo[]> {
    const repositories = repos || config.github.repos;

    if (!repositories || repositories.length === 0) {
      // Fetch all repos in the organization
      const { data: orgRepos } = await this.octokit.repos.listForOrg({
        org: config.github.org,
        type: 'all',
        per_page: 100,
      });
      return this.fetchPRsForRepos(orgRepos.map(r => r.name));
    }

    return this.fetchPRsForRepos(repositories);
  }

  /**
   * Fetch PRs for specific repositories
   */
  private async fetchPRsForRepos(repoNames: string[]): Promise<PRInfo[]> {
    const allPRs: PRInfo[] = [];

    for (const repo of repoNames) {
      try {
        const { data: prs } = await this.octokit.pulls.list({
          owner: config.github.org,
          repo,
          state: 'open',
          per_page: 100,
        });

        for (const pr of prs) {
          // Note: pulls.list doesn't include additions/deletions/changed_files
          // We'll fetch these details when needed for specific PRs
          allPRs.push({
            number: pr.number,
            title: pr.title,
            repository: repo,
            author: pr.user?.login || 'unknown',
            url: pr.html_url,
            created_at: pr.created_at,
            updated_at: pr.updated_at,
            state: 'open',
            draft: pr.draft || false,
            lines_added: 0, // Not available in list API
            lines_deleted: 0, // Not available in list API
            lines_changed: 0, // Not available in list API
            files_changed: 0, // Not available in list API
            requested_reviewers: pr.requested_reviewers?.map(r => r.login) || [],
            assignees: pr.assignees?.map(a => a.login) || [],
            labels: pr.labels?.map(l => l.name) || [],
          });
        }
      } catch (error) {
        console.error(`Error fetching PRs for ${repo}:`, error);
      }
    }

    return allPRs;
  }

  /**
   * Get a specific pull request
   */
  async getPullRequest(repo: string, prNumber: number): Promise<PRInfo | null> {
    try {
      const { data: pr } = await this.octokit.pulls.get({
        owner: config.github.org,
        repo,
        pull_number: prNumber,
      });

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
      };
    } catch (error) {
      console.error(`Error fetching PR ${prNumber} from ${repo}:`, error);
      return null;
    }
  }

  /**
   * Get reviews for a pull request
   */
  async getReviews(repo: string, prNumber: number): Promise<ReviewInfo[]> {
    try {
      const { data: reviews } = await this.octokit.pulls.listReviews({
        owner: config.github.org,
        repo,
        pull_number: prNumber,
        per_page: 100,
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
      console.error(`Error fetching reviews for PR ${prNumber}:`, error);
      return [];
    }
  }

  /**
   * Get files changed in a pull request
   */
  async getFilesChanged(repo: string, prNumber: number): Promise<string[]> {
    try {
      const { data: files } = await this.octokit.pulls.listFiles({
        owner: config.github.org,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });

      return files.map(f => f.filename);
    } catch (error) {
      console.error(`Error fetching files for PR ${prNumber}:`, error);
      return [];
    }
  }

  /**
   * Get commit history for a repository (for expertise mapping)
   */
  async getCommits(repo: string, since?: Date): Promise<any[]> {
    try {
      const options: any = {
        owner: config.github.org,
        repo,
        per_page: 100,
      };

      if (since) {
        options.since = since.toISOString();
      }

      const { data: commits } = await this.octokit.repos.listCommits(options);
      return commits;
    } catch (error) {
      console.error(`Error fetching commits for ${repo}:`, error);
      return [];
    }
  }

  /**
   * Get timeline events for a pull request
   */
  async getTimeline(repo: string, prNumber: number): Promise<any[]> {
    try {
      const { data: events } = await this.octokit.issues.listEventsForTimeline({
        owner: config.github.org,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });

      return events;
    } catch (error) {
      console.error(`Error fetching timeline for PR ${prNumber}:`, error);
      return [];
    }
  }

  /**
   * Get user information
   */
  async getUser(username: string): Promise<any> {
    try {
      const { data: user } = await this.octokit.users.getByUsername({
        username,
      });
      return user;
    } catch (error) {
      console.error(`Error fetching user ${username}:`, error);
      return null;
    }
  }

  /**
   * Search for commits by author in a specific repository
   */
  async searchCommitsByAuthor(repo: string, author: string, since?: Date): Promise<any[]> {
    try {
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
      return commits;
    } catch (error) {
      console.error(`Error searching commits by ${author}:`, error);
      return [];
    }
  }
}

// Singleton instance
export const githubClient = new GitHubClient();
