/**
 * Tool: get_pr_review_history
 * Get detailed review timeline for a specific PR
 */

import { githubClient } from '../github-client.js';
import { TimelineEvent, PRMetrics } from '../types.js';
import { z } from 'zod';

export const GetPRReviewHistorySchema = z.object({
  pr_number: z.number().describe('Pull request number'),
  repository: z.string().describe('Repository name'),
});

export type GetPRReviewHistoryParams = z.infer<typeof GetPRReviewHistorySchema>;

export async function getPRReviewHistory(params: GetPRReviewHistoryParams) {
  const { pr_number, repository } = params;

  // Get PR details
  const pr = await githubClient.getPullRequest(repository, pr_number);
  if (!pr) {
    throw new Error(`PR #${pr_number} not found in ${repository}`);
  }

  // Get reviews
  const reviews = await githubClient.getReviews(repository, pr_number);

  // Get timeline events
  const timelineEvents = await githubClient.getTimeline(repository, pr_number);

  // Build timeline
  const timeline: TimelineEvent[] = [];
  const prCreatedAt = new Date(pr.created_at);

  // Add PR creation event
  timeline.push({
    event: 'created',
    timestamp: pr.created_at,
    actor: pr.author,
    elapsed_hours: 0,
  });

  // Add review request events
  const reviewRequestEvents = timelineEvents.filter(
    e => e.event === 'review_requested'
  );
  for (const event of reviewRequestEvents) {
    const eventTime = new Date(event.created_at);
    const elapsedHours = (eventTime.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);

    timeline.push({
      event: 'review_requested',
      timestamp: event.created_at,
      actor: event.actor?.login || 'unknown',
      elapsed_hours: Math.round(elapsedHours * 100) / 100,
      details: {
        reviewers: event.requested_reviewer
          ? [event.requested_reviewer.login]
          : event.requested_team
          ? [event.requested_team.name]
          : [],
      },
    });
  }

  // Add review events
  let firstReviewAdded = false;
  for (const review of reviews) {
    const reviewTime = new Date(review.submitted_at);
    const elapsedHours = (reviewTime.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);

    timeline.push({
      event: firstReviewAdded ? 'review' : 'first_review',
      timestamp: review.submitted_at,
      actor: review.user,
      elapsed_hours: Math.round(elapsedHours * 100) / 100,
      details: {
        review_state: review.state,
        comments: review.comments_count,
      },
    });

    firstReviewAdded = true;
  }

  // Add commit/push events
  const pushEvents = timelineEvents.filter(e => e.event === 'committed' || e.event === 'head_ref_force_pushed');
  for (const event of pushEvents) {
    const eventTime = new Date(event.created_at);
    const elapsedHours = (eventTime.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);

    timeline.push({
      event: 'changes_pushed',
      timestamp: event.created_at,
      actor: event.actor?.login || event.author?.name || 'unknown',
      elapsed_hours: Math.round(elapsedHours * 100) / 100,
      details: {
        commits: 1,
      },
    });
  }

  // Sort timeline by timestamp
  timeline.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Calculate metrics
  const now = new Date();
  const ageHours = (now.getTime() - prCreatedAt.getTime()) / (1000 * 60 * 60);

  const firstReviewEvent = timeline.find(e => e.event === 'first_review');
  const timeToFirstReview = firstReviewEvent ? firstReviewEvent.elapsed_hours : null;

  const totalReviews = reviews.length;
  const totalReviewRounds = countReviewRounds(timeline);

  // Calculate waiting times
  const { waitingOnReviewers, waitingOnAuthor } = calculateWaitingTimes(timeline, reviews);

  // Determine current waiting status
  const lastEvent = timeline[timeline.length - 1];
  let currentlyWaitingOn: PRMetrics['currently_waiting_on'] = 'reviewers';

  if (lastEvent.event === 'review' && reviews.length > 0) {
    const lastReview = reviews[reviews.length - 1];
    if (lastReview.state === 'CHANGES_REQUESTED') {
      currentlyWaitingOn = 'author';
    } else if (lastReview.state === 'APPROVED') {
      currentlyWaitingOn = 'merge';
    }
  } else if (lastEvent.event === 'changes_pushed') {
    currentlyWaitingOn = 'reviewers';
  }

  const metrics: PRMetrics = {
    age_hours: Math.round(ageHours * 10) / 10,
    time_to_first_review_hours: timeToFirstReview,
    total_reviews: totalReviews,
    total_review_rounds: totalReviewRounds,
    time_waiting_on_reviewers_hours: Math.round(waitingOnReviewers * 10) / 10,
    time_waiting_on_author_hours: Math.round(waitingOnAuthor * 10) / 10,
    currently_waiting_on: currentlyWaitingOn,
  };

  // Determine status
  let status: 'fresh' | 'aging' | 'stale' | 'critical';
  if (ageHours < 24) {
    status = 'fresh';
  } else if (ageHours < 72) {
    status = 'aging';
  } else if (ageHours < 168) {
    status = 'stale';
  } else {
    status = 'critical';
  }

  return {
    pr: {
      number: pr.number,
      title: pr.title,
      repository: pr.repository,
      author: pr.author,
      created_at: pr.created_at,
      state: pr.state,
      draft: pr.draft,
    },
    timeline,
    metrics,
    status,
  };
}

function countReviewRounds(timeline: TimelineEvent[]): number {
  let rounds = 0;
  let lastEventType: string | null = null;

  for (const event of timeline) {
    if (event.event === 'review' || event.event === 'first_review') {
      if (lastEventType !== 'review' && lastEventType !== 'first_review') {
        rounds++;
      }
      lastEventType = 'review';
    } else if (event.event === 'changes_pushed') {
      lastEventType = 'changes_pushed';
    }
  }

  return rounds;
}

function calculateWaitingTimes(
  timeline: TimelineEvent[],
  reviews: any[]
): { waitingOnReviewers: number; waitingOnAuthor: number } {
  let waitingOnReviewers = 0;
  let waitingOnAuthor = 0;
  let currentState: 'waiting_reviewers' | 'waiting_author' = 'waiting_reviewers';
  let lastTimestamp = timeline[0]?.timestamp || new Date().toISOString();

  for (let i = 1; i < timeline.length; i++) {
    const event = timeline[i];
    const prevTimestamp = new Date(lastTimestamp);
    const currentTimestamp = new Date(event.timestamp);
    const hoursElapsed = (currentTimestamp.getTime() - prevTimestamp.getTime()) / (1000 * 60 * 60);

    if (currentState === 'waiting_reviewers') {
      waitingOnReviewers += hoursElapsed;
    } else {
      waitingOnAuthor += hoursElapsed;
    }

    // Update state based on event
    if (event.event === 'review' || event.event === 'first_review') {
      const review = reviews.find(r => r.submitted_at === event.timestamp);
      if (review?.state === 'CHANGES_REQUESTED' || review?.state === 'COMMENTED') {
        currentState = 'waiting_author';
      }
    } else if (event.event === 'changes_pushed') {
      currentState = 'waiting_reviewers';
    }

    lastTimestamp = event.timestamp;
  }

  // Add time from last event to now
  const now = new Date();
  const lastEventTime = new Date(lastTimestamp);
  const finalHours = (now.getTime() - lastEventTime.getTime()) / (1000 * 60 * 60);

  if (currentState === 'waiting_reviewers') {
    waitingOnReviewers += finalHours;
  } else {
    waitingOnAuthor += finalHours;
  }

  return { waitingOnReviewers, waitingOnAuthor };
}
