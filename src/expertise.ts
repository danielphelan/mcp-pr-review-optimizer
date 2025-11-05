/**
 * Expertise calculation engine
 * Analyzes commits and reviews to determine developer expertise
 */

import { githubClient } from './github-client.js';
import { config } from './config.js';
import { cache, CACHE_TTL } from './cache.js';
import { ExpertiseScore } from './types.js';

export interface FileExpertise {
  [filePath: string]: {
    [developer: string]: ExpertiseScore;
  };
}

export interface DirectoryExpertise {
  [directory: string]: {
    [developer: string]: ExpertiseScore;
  };
}

export interface LanguageExpertise {
  [language: string]: {
    [developer: string]: ExpertiseScore;
  };
}

/**
 * Calculate expertise scores for all developers
 */
export async function calculateExpertise(repo: string): Promise<{
  fileExpertise: FileExpertise;
  directoryExpertise: DirectoryExpertise;
  languageExpertise: LanguageExpertise;
}> {
  const cacheKey = `expertise:${repo}`;
  const cached = cache.get<any>(cacheKey);
  if (cached) {
    return cached;
  }

  const lookbackDate = new Date();
  lookbackDate.setDate(lookbackDate.getDate() - config.expertise.lookbackDays);

  // Get all commits in the lookback period
  const commits = await githubClient.getCommits(repo, lookbackDate);

  // Get all PRs to analyze reviews
  const prs = await githubClient.getOpenPullRequests([repo]);

  const fileExpertise: FileExpertise = {};
  const directoryExpertise: DirectoryExpertise = {};
  const languageExpertise: LanguageExpertise = {};

  // Analyze commits
  for (const commit of commits) {
    const author = commit.author?.login || commit.commit?.author?.name;
    if (!author) continue;

    // Get files changed in this commit
    try {
      const { data: commitDetails } = await (githubClient as any).octokit.repos.getCommit({
        owner: config.github.org,
        repo,
        ref: commit.sha,
      });

      for (const file of commitDetails.files || []) {
        const filePath = file.filename;
        const directory = filePath.split('/').slice(0, -1).join('/') || '/';
        const language = getLanguageFromFile(filePath);

        // Update file expertise
        if (!fileExpertise[filePath]) {
          fileExpertise[filePath] = {};
        }
        if (!fileExpertise[filePath][author]) {
          fileExpertise[filePath][author] = {
            file_path: filePath,
            score: 0,
            commit_count: 0,
            review_count: 0,
            last_activity: commit.commit.author?.date || '',
          };
        }
        fileExpertise[filePath][author].commit_count++;
        fileExpertise[filePath][author].last_activity = commit.commit.author?.date || '';

        // Update directory expertise
        if (!directoryExpertise[directory]) {
          directoryExpertise[directory] = {};
        }
        if (!directoryExpertise[directory][author]) {
          directoryExpertise[directory][author] = {
            directory,
            score: 0,
            commit_count: 0,
            review_count: 0,
            last_activity: commit.commit.author?.date || '',
          };
        }
        directoryExpertise[directory][author].commit_count++;
        directoryExpertise[directory][author].last_activity = commit.commit.author?.date || '';

        // Update language expertise
        if (language) {
          if (!languageExpertise[language]) {
            languageExpertise[language] = {};
          }
          if (!languageExpertise[language][author]) {
            languageExpertise[language][author] = {
              language,
              score: 0,
              commit_count: 0,
              review_count: 0,
              last_activity: commit.commit.author?.date || '',
            };
          }
          languageExpertise[language][author].commit_count++;
          languageExpertise[language][author].last_activity = commit.commit.author?.date || '';
        }
      }
    } catch (error) {
      // Skip commits that can't be fetched
      continue;
    }
  }

  // Analyze reviews (for closed/merged PRs in the lookback period)
  // Note: This is simplified - in production, you'd want to fetch closed PRs too
  for (const pr of prs) {
    const reviews = await githubClient.getReviews(repo, pr.number);
    const files = await githubClient.getFilesChanged(repo, pr.number);

    for (const review of reviews) {
      const reviewer = review.user;
      for (const filePath of files) {
        const directory = filePath.split('/').slice(0, -1).join('/') || '/';
        const language = getLanguageFromFile(filePath);

        // Update file expertise from reviews
        if (!fileExpertise[filePath]) {
          fileExpertise[filePath] = {};
        }
        if (!fileExpertise[filePath][reviewer]) {
          fileExpertise[filePath][reviewer] = {
            file_path: filePath,
            score: 0,
            commit_count: 0,
            review_count: 0,
            last_activity: review.submitted_at,
          };
        }
        fileExpertise[filePath][reviewer].review_count++;
        fileExpertise[filePath][reviewer].last_activity = review.submitted_at;

        // Update directory expertise from reviews
        if (!directoryExpertise[directory]) {
          directoryExpertise[directory] = {};
        }
        if (!directoryExpertise[directory][reviewer]) {
          directoryExpertise[directory][reviewer] = {
            directory,
            score: 0,
            commit_count: 0,
            review_count: 0,
            last_activity: review.submitted_at,
          };
        }
        directoryExpertise[directory][reviewer].review_count++;

        // Update language expertise from reviews
        if (language) {
          if (!languageExpertise[language]) {
            languageExpertise[language] = {};
          }
          if (!languageExpertise[language][reviewer]) {
            languageExpertise[language][reviewer] = {
              language,
              score: 0,
              commit_count: 0,
              review_count: 0,
              last_activity: review.submitted_at,
            };
          }
          languageExpertise[language][reviewer].review_count++;
        }
      }
    }
  }

  // Calculate final scores using weighted formula
  const commitWeight = config.expertise.commitWeight;
  const reviewWeight = config.expertise.reviewWeight;

  // Calculate scores for file expertise
  for (const filePath in fileExpertise) {
    const maxCommits = Math.max(...Object.values(fileExpertise[filePath]).map(e => e.commit_count));
    const maxReviews = Math.max(...Object.values(fileExpertise[filePath]).map(e => e.review_count));

    for (const developer in fileExpertise[filePath]) {
      const expertise = fileExpertise[filePath][developer];
      const commitScore = maxCommits > 0 ? expertise.commit_count / maxCommits : 0;
      const reviewScore = maxReviews > 0 ? expertise.review_count / maxReviews : 0;
      expertise.score = commitScore * commitWeight + reviewScore * reviewWeight;
    }
  }

  // Calculate scores for directory expertise
  for (const directory in directoryExpertise) {
    const maxCommits = Math.max(...Object.values(directoryExpertise[directory]).map(e => e.commit_count));
    const maxReviews = Math.max(...Object.values(directoryExpertise[directory]).map(e => e.review_count));

    for (const developer in directoryExpertise[directory]) {
      const expertise = directoryExpertise[directory][developer];
      const commitScore = maxCommits > 0 ? expertise.commit_count / maxCommits : 0;
      const reviewScore = maxReviews > 0 ? expertise.review_count / maxReviews : 0;
      expertise.score = commitScore * commitWeight + reviewScore * reviewWeight;
    }
  }

  // Calculate scores for language expertise
  for (const language in languageExpertise) {
    const maxCommits = Math.max(...Object.values(languageExpertise[language]).map(e => e.commit_count));
    const maxReviews = Math.max(...Object.values(languageExpertise[language]).map(e => e.review_count));

    for (const developer in languageExpertise[language]) {
      const expertise = languageExpertise[language][developer];
      const commitScore = maxCommits > 0 ? expertise.commit_count / maxCommits : 0;
      const reviewScore = maxReviews > 0 ? expertise.review_count / maxReviews : 0;
      expertise.score = commitScore * commitWeight + reviewScore * reviewWeight;
    }
  }

  const result = { fileExpertise, directoryExpertise, languageExpertise };
  cache.set(cacheKey, result, CACHE_TTL.EXPERTISE);

  return result;
}

/**
 * Get expertise for a specific developer
 */
export async function getDeveloperExpertise(repo: string, developer: string): Promise<{
  files: ExpertiseScore[];
  directories: ExpertiseScore[];
  languages: ExpertiseScore[];
}> {
  const { fileExpertise, directoryExpertise, languageExpertise } = await calculateExpertise(repo);

  const files: ExpertiseScore[] = [];
  for (const filePath in fileExpertise) {
    if (fileExpertise[filePath][developer]) {
      files.push(fileExpertise[filePath][developer]);
    }
  }

  const directories: ExpertiseScore[] = [];
  for (const directory in directoryExpertise) {
    if (directoryExpertise[directory][developer]) {
      directories.push(directoryExpertise[directory][developer]);
    }
  }

  const languages: ExpertiseScore[] = [];
  for (const language in languageExpertise) {
    if (languageExpertise[language][developer]) {
      languages.push(languageExpertise[language][developer]);
    }
  }

  return {
    files: files.sort((a, b) => b.score - a.score),
    directories: directories.sort((a, b) => b.score - a.score),
    languages: languages.sort((a, b) => b.score - a.score),
  };
}

/**
 * Get language from file extension
 */
function getLanguageFromFile(filePath: string): string | null {
  const extensionMap: { [ext: string]: string } = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.py': 'Python',
    '.java': 'Java',
    '.go': 'Go',
    '.rs': 'Rust',
    '.cpp': 'C++',
    '.c': 'C',
    '.h': 'C',
    '.hpp': 'C++',
    '.cs': 'C#',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.swift': 'Swift',
    '.kt': 'Kotlin',
    '.scala': 'Scala',
    '.r': 'R',
    '.m': 'Objective-C',
    '.sql': 'SQL',
    '.sh': 'Shell',
    '.yaml': 'YAML',
    '.yml': 'YAML',
    '.json': 'JSON',
    '.md': 'Markdown',
  };

  const extension = '.' + filePath.split('.').pop();
  return extensionMap[extension.toLowerCase()] || null;
}
