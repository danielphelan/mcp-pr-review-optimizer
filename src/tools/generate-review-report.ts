/**
 * Tool: generate_review_report
 * Generate comprehensive review health report in Markdown format
 */

import { getStalePRs } from './get-stale-prs.js';
import { getReviewMetrics } from './get-review-metrics.js';
import { getReviewerWorkload } from './get-reviewer-workload.js';
import { analyzeReviewBottlenecks } from './analyze-review-bottlenecks.js';
import { suggestReviewers } from './suggest-reviewers.js';
import { githubClient } from '../github-client.js';
import { z } from 'zod';

export const GenerateReviewReportSchema = z.object({
  repositories: z.array(z.string()).optional().describe('List of repository names'),
  days_back: z.number().optional().describe('Number of days to analyze, default 7'),
  include_recommendations: z.boolean().optional().describe('Include recommendations, default true'),
});

export type GenerateReviewReportParams = z.infer<typeof GenerateReviewReportSchema>;

export async function generateReviewReport(params: GenerateReviewReportParams) {
  const {
    repositories,
    days_back = 7,
    include_recommendations = true,
  } = params;

  // Gather all data
  const stalePRsData = await getStalePRs({ repositories, age_threshold_hours: 72 });
  const reviewMetricsRaw = await getReviewMetrics({ repositories, group_by: 'reviewer' });
  const workloadData = await getReviewerWorkload({ repositories });
  const bottlenecks = await analyzeReviewBottlenecks({ repositories, days_back });

  // Type guard: We know we called with group_by: 'reviewer'
  const reviewMetrics = reviewMetricsRaw as {
    period: string;
    metrics_by_reviewer: Array<{
      reviewer: string;
      prs_reviewed: number;
      avg_first_response_hours: number;
      avg_review_completion_hours: number;
      approval_rate: number;
      request_changes_rate: number;
      comment_only_rate: number;
      current_assigned_prs: number;
    }>;
    team_averages: {
      avg_first_response_hours: number;
      avg_review_completion_hours: number;
      approval_rate: number;
    };
  };

  // Get all open PRs for additional context
  const allPRs = await githubClient.getOpenPullRequests(repositories);

  // Start building the report
  let report = '';

  // Header
  const now = new Date();
  const startDate = new Date(now.getTime() - days_back * 24 * 60 * 60 * 1000);
  const repoList = repositories?.join(', ') || 'All repositories';

  report += '# PR Review Health Report\n\n';
  report += `**Period**: ${startDate.toISOString().split('T')[0]} - ${now.toISOString().split('T')[0]}\n`;
  report += `**Repositories**: ${repoList}\n`;
  report += `**Generated**: ${now.toISOString().replace('T', ' ').split('.')[0]} UTC\n\n`;
  report += '---\n\n';

  // Overview
  report += '## 📊 Overview\n\n';
  report += `- **Total Open PRs**: ${allPRs.length}\n`;
  report += `- **Stale PRs (>3 days)**: ${stalePRsData.summary.stale + stalePRsData.summary.critical}\n`;
  report += `- **Critical PRs (>7 days)**: ${stalePRsData.summary.critical}\n`;
  report += `- **Average Review Time**: ${reviewMetrics.team_averages.avg_first_response_hours.toFixed(1)} hours\n`;

  const capacityPercent = Math.round(workloadData.team_capacity.avg_capacity_score * 100);
  const capacityStatus = capacityPercent > 70 ? 'Good' : capacityPercent > 40 ? 'Moderate pressure' : 'High pressure';
  report += `- **Team Capacity**: ${capacityPercent}% (${capacityStatus})\n\n`;
  report += '---\n\n';

  // Urgent PRs
  if (stalePRsData.stale_prs.length > 0) {
    report += '## 🚨 Urgent: PRs Needing Attention\n\n';
    report += '| PR | Repository | Author | Age | Waiting On | Action Needed |\n';
    report += '|----|------------|--------|-----|------------|---------------|\n';

    for (const pr of stalePRsData.stale_prs.slice(0, 10)) {
      const action = pr.waiting_on === 'reviewers' ? 'Assign reviewers' : 'Ping author for updates';
      report += `| [#${pr.number}](${pr.url}) | ${pr.repository} | ${pr.author} | ${Math.floor(pr.age_hours / 24)}d | ${pr.waiting_on} | ${action} |\n`;
    }

    report += '\n---\n\n';
  }

  // Reviewer Performance
  report += '## 👥 Reviewer Performance\n\n';
  report += '### Top Performers ⭐\n\n';

  const topReviewers = reviewMetrics.metrics_by_reviewer
    .sort((a, b) => b.prs_reviewed - a.prs_reviewed)
    .slice(0, 3);

  topReviewers.forEach((reviewer, index) => {
    report += `${index + 1}. **${reviewer.reviewer}** - ${reviewer.prs_reviewed} reviews, ${reviewer.avg_first_response_hours.toFixed(1)}h avg response, ${Math.round(reviewer.approval_rate * 100)}% approval rate\n`;
  });

  report += '\n### Current Workload\n\n';
  report += '| Reviewer | Assigned | Pending | Last 7d | Status | Capacity |\n';
  report += '|----------|----------|---------|---------|--------|----------|\n';

  for (const w of workloadData.workload) {
    const statusEmoji = w.status === 'available' ? '✅' : w.status === 'at_capacity' ? '⚠️' : w.status === 'ooo' ? '🏖️' : '➖';
    const statusText = w.status === 'available' ? 'Available' : w.status === 'at_capacity' ? 'At Capacity' : w.status === 'ooo' ? 'OOO' : 'Moderate';
    const capacityBar = '●'.repeat(Math.ceil(w.capacity_score * 9));
    const capacityPct = Math.round(w.capacity_score * 100);

    report += `| ${w.reviewer} | ${w.assigned_prs} | ${w.prs_awaiting_review} | ${w.prs_reviewed_last_7_days} | ${statusEmoji} ${statusText} | ${capacityBar} ${capacityPct}% |\n`;
  }

  report += '\n---\n\n';

  // Bottleneck Analysis
  if (bottlenecks.bottlenecks.length > 0) {
    report += '## 🔍 Bottleneck Analysis\n\n';

    const highSeverity = bottlenecks.bottlenecks.filter(b => b.severity === 'high');
    const mediumSeverity = bottlenecks.bottlenecks.filter(b => b.severity === 'medium');

    if (highSeverity.length > 0) {
      report += '### 🔴 High Severity\n\n';

      for (const bottleneck of highSeverity) {
        if (bottleneck.type === 'reviewer') {
          report += `**Reviewer Overload: ${bottleneck.name}**\n`;
          report += `- ${bottleneck.details.prs_assigned} PRs assigned (team avg: ${Math.round(workloadData.team_capacity.total_assigned / workloadData.workload.length)})\n`;
          report += `- ${bottleneck.details.avg_first_response_hours}h avg first response\n`;
          report += `- ${bottleneck.details.prs_overdue} PRs overdue\n\n`;
          report += `**Recommendation**: ${bottleneck.details.recommendation}\n\n`;
        } else if (bottleneck.type === 'repository') {
          report += `**Repository: ${bottleneck.name}**\n`;
          report += `- ${bottleneck.details.avg_review_time_hours}h avg review time\n`;
          report += `- ${bottleneck.details.prs_open_over_7_days} PRs open >7 days\n`;
          report += `- ${bottleneck.details.common_issues}\n\n`;
          report += `**Recommendation**: ${bottleneck.details.recommendation}\n\n`;
        }
      }
    }

    if (mediumSeverity.length > 0) {
      report += '### 🟡 Medium Severity\n\n';

      for (const bottleneck of mediumSeverity) {
        if (bottleneck.type === 'pr_size') {
          report += `**PR Size: ${bottleneck.name}**\n`;
          report += `- ${bottleneck.details.prs_over_500_lines} PRs over 500 lines\n`;
          report += `- ${bottleneck.details.avg_review_time_hours}h avg review time\n\n`;
          report += `**Recommendation**: ${bottleneck.details.recommendation}\n\n`;
        }
      }
    }

    report += '---\n\n';
  }

  // Trends
  report += '## 📈 Trends\n\n';
  report += '| Metric | Current | Status |\n';
  report += '|--------|---------|--------|\n';
  report += `| Avg Review Time | ${reviewMetrics.team_averages.avg_first_response_hours.toFixed(1)}h | ${bottlenecks.trends.avg_review_time_increasing ? '↗️ Increasing' : '✅ Stable'} |\n`;
  report += `| Open PRs | ${allPRs.length} | ${bottlenecks.trends.review_requests_increasing ? '↗️ Increasing' : '✅ Stable'} |\n`;
  report += `| Team Capacity | ${capacityPercent}% | ${bottlenecks.trends.team_capacity_decreasing ? '↘️ Decreasing' : '✅ Stable'} |\n\n`;

  if (bottlenecks.trends.avg_review_time_increasing) {
    report += '**Trend Alert**: Review times increasing, may indicate growing bottleneck\n\n';
  }

  report += '---\n\n';

  // Recommendations
  if (include_recommendations && bottlenecks.recommendations.length > 0) {
    report += '## 💡 Recommendations\n\n';
    report += '### Immediate Actions\n\n';

    bottlenecks.recommendations.slice(0, 3).forEach((rec, i) => {
      report += `${i + 1}. ${rec}\n`;
    });

    report += '\n### Long-term Initiatives\n\n';
    report += '- Cross-train team members on critical codebases\n';
    report += '- Implement automated review assignment based on expertise\n';
    report += '- Set up PR size guidelines and automated checks\n';
    report += '- Review and update code review guidelines\n\n';

    report += '---\n\n';
  }

  // Reviewer suggestions for urgent PRs
  if (stalePRsData.stale_prs.length > 0) {
    report += '## 🎯 Reviewer Suggestions for Stale PRs\n\n';

    // Get suggestions for top 3 stale PRs
    const urgentPRs = stalePRsData.stale_prs
      .filter(pr => pr.waiting_on === 'reviewers')
      .slice(0, 3);

    for (const pr of urgentPRs) {
      try {
        const suggestions = await suggestReviewers({
          pr_number: pr.number,
          repository: pr.repository,
          count: 3,
        });

        report += `### PR #${pr.number}: "${pr.title}"\n\n`;
        report += '**Recommended Reviewers**:\n\n';

        suggestions.suggestions.forEach((s, i) => {
          report += `${i + 1}. **${s.reviewer}** (Score: ${Math.round(s.score * 100)}%)\n`;
          s.reasons.forEach(reason => {
            report += `   - ${reason}\n`;
          });
          if (s.warning) {
            report += `   - ⚠️ ${s.warning}\n`;
          }
          report += '\n';
        });
      } catch (error) {
        // Skip if we can't get suggestions
        continue;
      }
    }

    report += '---\n\n';
  }

  // Footer
  report += '*Report generated by PR Review Optimizer MCP Server*\n';

  return report;
}
