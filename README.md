# MCP PR Review Optimizer

An MCP (Model Context Protocol) server to optimize the pull request review process by tracking PR aging, measuring review response times, analyzing approval patterns, and intelligently suggesting reviewers based on expertise and availability.

## Features

- **🔍 Stale PR Detection**: Identify PRs that need urgent attention based on age
- **📊 Review Metrics**: Analyze team review performance and response times
- **👥 Workload Management**: Track reviewer capacity and current assignments
- **🎯 Smart Reviewer Suggestions**: AI-powered reviewer recommendations based on:
  - Code expertise (file/directory/language knowledge)
  - Current availability and workload
  - Historical review speed
- **🚨 Bottleneck Analysis**: Identify review process bottlenecks and get actionable recommendations
- **📈 Comprehensive Reports**: Generate detailed review health reports with trends and insights
- **⏱️ PR Timeline Tracking**: Get detailed history and metrics for individual PRs

## Architecture

This server implements the **MCP Streamable HTTP Transport**, providing:
- Single HTTP endpoint for bidirectional communication
- Server-Sent Events (SSE) for real-time streaming responses
- Stateful session management
- Compatible with web-based MCP clients and Claude Desktop

## Installation

### Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- GitHub Personal Access Token with the following scopes:
  - `repo` (full repository access)
  - `read:org` (read organization data)

### Setup

1. **Clone the repository**:
   ```bash
   git clone <your-repo-url>
   cd mcp-pr-review-optimizer
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment variables**:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your configuration:
   ```env
   # GitHub Configuration (Required)
   GITHUB_TOKEN=ghp_your_github_personal_access_token
   GITHUB_ORG=your-organization-name

   # Optional: Specific repositories to monitor
   GITHUB_REPOS=backend-api,frontend-app,mobile-app

   # Optional: Team members to track
   GITHUB_REVIEWERS=alice,bob,charlie,diana,eve

   # Optional: Thresholds
   STALE_PR_THRESHOLD_HOURS=72
   CRITICAL_PR_THRESHOLD_HOURS=168
   HIGH_WORKLOAD_THRESHOLD=6

   # Optional: Expertise calculation
   EXPERTISE_COMMIT_WEIGHT=0.6
   EXPERTISE_REVIEW_WEIGHT=0.4
   EXPERTISE_LOOKBACK_DAYS=90

   # Server Configuration
   PORT=3000
   HOST=localhost
   ```

4. **Build the project**:
   ```bash
   npm run build
   ```

5. **Start the server**:
   ```bash
   npm start
   ```

The server will be available at `http://localhost:3000/mcp`

## Development

For development with auto-rebuild:

```bash
npm run dev
```

## Usage with Claude

### Claude Desktop Configuration

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "pr-review-optimizer": {
      "url": "http://localhost:3000/mcp",
      "transport": "streamable-http"
    }
  }
}
```

### Example Conversations

#### 1. Check for stale PRs
```
User: What PRs need my attention today?

Claude: [uses get_stale_prs tool]
You have 5 PRs that need attention:

Critical (>7 days):
- PR #1234: "Add user authentication" by alice - waiting 7 days
- PR #1256: "Update payment flow" by frank - waiting 8 days

Stale (3-7 days):
- PR #1289: "Fix login bug" by bob - waiting 4 days
...
```

#### 2. Get reviewer suggestions
```
User: Who should review PR #1267 in backend-api?

Claude: [uses suggest_reviewers tool]
For PR #1267 "Refactor authentication module", I recommend:

1. bob (Score: 92%) - Best choice
   - High expertise in authentication code
   - Fast response time (avg 4.5 hours)
   - Currently available (3 PRs assigned)

2. diana (Score: 88%) - Great alternative
   - Moderate auth expertise
   - Very available (only 1 PR assigned)
```

#### 3. Analyze bottlenecks
```
User: Why are our reviews taking so long lately?

Claude: [uses analyze_review_bottlenecks tool]
I've identified 3 main bottlenecks:

1. charlie is overloaded (High Severity)
   - Has 8 PRs assigned vs team average of 3
   - Response time increased to 36.5 hours

2. backend-api has large PRs (Medium Severity)
   - Average PR size: 650 lines
   - Review time: 48 hours vs 18 hour average

Recommendation: Redistribute some of charlie's PRs to diana and bob
```

#### 4. Generate weekly report
```
User: Generate my weekly review report

Claude: [uses generate_review_report tool]
# PR Review Health Report

**Period**: 2025-01-13 - 2025-01-20
**Repositories**: All repositories
**Generated**: 2025-01-20 10:30:00 UTC

## 📊 Overview

- Total Open PRs: 23
- Stale PRs (>3 days): 5
- Critical PRs (>7 days): 2
- Average Review Time: 18.4 hours
- Team Capacity: 60% (Moderate pressure)
...
```

## Available Tools

### 1. `get_stale_prs`
Find pull requests that need attention due to age.

**Parameters**:
- `repositories` (optional): List of repository names
- `age_threshold_hours` (optional): Age threshold, default 72
- `exclude_draft` (optional): Exclude drafts, default true
- `exclude_wip` (optional): Exclude WIP PRs, default true

### 2. `get_review_metrics`
Analyze review response times and patterns.

**Parameters**:
- `repositories` (optional): List of repository names
- `start_date` (optional): ISO date, default 7 days ago
- `end_date` (optional): ISO date, default today
- `group_by` (optional): "reviewer" | "repository" | "author"

### 3. `get_reviewer_workload`
Check current review capacity for team members.

**Parameters**:
- `reviewers` (optional): List of GitHub usernames
- `repositories` (optional): List of repository names
- `include_draft` (optional): Include draft PRs, default false

### 4. `suggest_reviewers`
Recommend optimal reviewers for a PR.

**Parameters** (required):
- `pr_number`: Pull request number
- `repository`: Repository name
- `count` (optional): Number of suggestions, default 3
- `prioritize` (optional): "expertise" | "availability" | "speed" | "balanced"

### 5. `analyze_review_bottlenecks`
Identify where reviews are getting stuck.

**Parameters**:
- `repositories` (optional): List of repository names
- `days_back` (optional): Days to analyze, default 14
- `min_prs` (optional): Minimum PRs required, default 5

### 6. `get_pr_review_history`
Get detailed review timeline for a specific PR.

**Parameters** (required):
- `pr_number`: Pull request number
- `repository`: Repository name

### 7. `generate_review_report`
Generate comprehensive review health report in Markdown.

**Parameters**:
- `repositories` (optional): List of repository names
- `days_back` (optional): Days to analyze, default 7
- `include_recommendations` (optional): Include recommendations, default true

## How It Works

### Expertise Calculation

The server analyzes Git history to build expertise maps:

- **Commits** (60% weight): Files modified, lines changed
- **Reviews** (40% weight): Files reviewed, comments made
- **Lookback period**: Last 90 days (configurable)

Expertise scores:
- 0.0 - 0.3: Low expertise
- 0.3 - 0.6: Moderate expertise
- 0.6 - 0.9: High expertise
- 0.9 - 1.0: Expert

### Availability Calculation

Capacity score based on:
- Current assigned PRs (40% weight)
- PRs reviewed in last 7 days (30% weight)
- Average concurrent PR count (30% weight)

Status categories:
- **Available**: Capacity score > 0.6
- **Moderate Load**: Capacity score 0.3 - 0.6
- **At Capacity**: Capacity score < 0.3
- **Out of Office**: No recent activity

### Caching Strategy

- **Expertise maps**: 24 hours
- **Workload data**: 1 hour
- **PR data**: 15 minutes
- **Real-time queries**: No cache

## Configuration Options

### Thresholds

- `STALE_PR_THRESHOLD_HOURS`: When PRs are considered stale (default: 72)
- `CRITICAL_PR_THRESHOLD_HOURS`: When PRs are critical (default: 168)
- `HIGH_WORKLOAD_THRESHOLD`: Max PRs per reviewer (default: 6)

### Expertise Settings

- `EXPERTISE_COMMIT_WEIGHT`: Weight for commits in expertise (default: 0.6)
- `EXPERTISE_REVIEW_WEIGHT`: Weight for reviews in expertise (default: 0.4)
- `EXPERTISE_LOOKBACK_DAYS`: Days to look back for expertise (default: 90)

## API Rate Limiting

The server uses the GitHub API, which has the following limits:

- **Authenticated requests**: 5,000 requests/hour
- The server implements caching to minimize API calls
- Exponential backoff is used for rate limit errors

## Troubleshooting

### "GITHUB_TOKEN environment variable is required"

Make sure you've created a `.env` file with your GitHub token:
```bash
cp .env.example .env
# Edit .env and add your GITHUB_TOKEN
```

### "API rate limit exceeded"

The server may be making too many GitHub API requests. Try:
1. Reducing the number of repositories being monitored
2. Increasing cache TTLs (modify `src/cache.ts`)
3. Waiting for the rate limit to reset (resets hourly)

### Empty or incomplete results

- Ensure your GitHub token has the correct scopes (`repo`, `read:org`)
- Verify the organization name and repository names are correct
- Check that you have access to the repositories you're querying

## Security Considerations

- **Never commit your `.env` file** - it contains sensitive tokens
- Use GitHub tokens with minimal required permissions
- Only analyze repositories you have access to
- The server respects private repository permissions
- Consider running the server in a secure, private network

## Future Enhancements

- [ ] Slack integration for notifications
- [ ] GitHub Actions for automated reviewer assignment
- [ ] Machine learning for improved suggestions
- [ ] Review quality metrics
- [ ] Cross-repository expertise insights
- [ ] Visual dashboard
- [ ] PR size enforcement
- [ ] SLA tracking
- [ ] Calendar integration for PTO

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

For issues, questions, or contributions, please open an issue on GitHub.

---

Built with the [Model Context Protocol](https://modelcontextprotocol.io/)
