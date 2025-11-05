/**
 * MCP PR Review Optimizer Server
 * Main entry point with Streamable HTTP transport
 */

import express, { Request, Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { config } from './config.js';

// Import tool implementations
import { getStalePRs, GetStalePRsSchema } from './tools/get-stale-prs.js';
import { getReviewMetrics, GetReviewMetricsSchema } from './tools/get-review-metrics.js';
import { getReviewerWorkload, GetReviewerWorkloadSchema } from './tools/get-reviewer-workload.js';
import { suggestReviewers, SuggestReviewersSchema } from './tools/suggest-reviewers.js';
import { analyzeReviewBottlenecks, AnalyzeReviewBottlenecksSchema } from './tools/analyze-review-bottlenecks.js';
import { getPRReviewHistory, GetPRReviewHistorySchema } from './tools/get-pr-review-history.js';
import { generateReviewReport, GenerateReviewReportSchema } from './tools/generate-review-report.js';

// Define available tools
const TOOLS: Tool[] = [
  {
    name: 'get_stale_prs',
    description: 'Find pull requests that need attention due to age. Returns PRs that have been open longer than the threshold (default 72 hours), categorized by urgency.',
    inputSchema: {
      type: 'object',
      properties: {
        repositories: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of repository names to check. If not provided, checks all configured repositories.',
        },
        age_threshold_hours: {
          type: 'number',
          description: 'Age threshold in hours. PRs older than this are considered stale. Default: 72',
        },
        exclude_draft: {
          type: 'boolean',
          description: 'Exclude draft PRs from results. Default: true',
        },
        exclude_wip: {
          type: 'boolean',
          description: 'Exclude PRs with "WIP" in the title. Default: true',
        },
      },
    },
  },
  {
    name: 'get_review_metrics',
    description: 'Analyze review response times and patterns for reviewers, repositories, or authors. Provides insights into review speed, approval rates, and current workload.',
    inputSchema: {
      type: 'object',
      properties: {
        repositories: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of repository names to analyze.',
        },
        start_date: {
          type: 'string',
          description: 'Start date in ISO format (YYYY-MM-DD). Default: 7 days ago',
        },
        end_date: {
          type: 'string',
          description: 'End date in ISO format (YYYY-MM-DD). Default: today',
        },
        group_by: {
          type: 'string',
          enum: ['reviewer', 'repository', 'author'],
          description: 'Group results by reviewer, repository, or author. Default: reviewer',
        },
      },
    },
  },
  {
    name: 'get_reviewer_workload',
    description: 'Check current review capacity and workload for team members. Shows assigned PRs, pending reviews, and availability status.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of GitHub usernames to check. If not provided, checks all configured reviewers.',
        },
        repositories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit to specific repositories.',
        },
        include_draft: {
          type: 'boolean',
          description: 'Include draft PRs in workload calculation. Default: false',
        },
      },
    },
  },
  {
    name: 'suggest_reviewers',
    description: 'Recommend optimal reviewers for a specific PR based on code expertise, availability, and review speed. Returns ranked suggestions with detailed reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: {
          type: 'number',
          description: 'Pull request number (required)',
        },
        repository: {
          type: 'string',
          description: 'Repository name (required)',
        },
        count: {
          type: 'number',
          description: 'Number of reviewer suggestions to return. Default: 3',
        },
        prioritize: {
          type: 'string',
          enum: ['expertise', 'availability', 'speed', 'balanced'],
          description: 'Prioritization strategy. Default: balanced',
        },
      },
      required: ['pr_number', 'repository'],
    },
  },
  {
    name: 'analyze_review_bottlenecks',
    description: 'Identify where reviews are getting stuck and what is slowing down the review process. Analyzes overloaded reviewers, slow repositories, and large PRs.',
    inputSchema: {
      type: 'object',
      properties: {
        repositories: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of repository names to analyze.',
        },
        days_back: {
          type: 'number',
          description: 'Number of days to look back for analysis. Default: 14',
        },
        min_prs: {
          type: 'number',
          description: 'Minimum number of PRs required to perform analysis. Default: 5',
        },
      },
    },
  },
  {
    name: 'get_pr_review_history',
    description: 'Get detailed review timeline and metrics for a specific PR. Shows all events, waiting times, and current status.',
    inputSchema: {
      type: 'object',
      properties: {
        pr_number: {
          type: 'number',
          description: 'Pull request number (required)',
        },
        repository: {
          type: 'string',
          description: 'Repository name (required)',
        },
      },
      required: ['pr_number', 'repository'],
    },
  },
  {
    name: 'generate_review_report',
    description: 'Generate a comprehensive PR review health report in Markdown format. Includes overview, metrics, bottlenecks, trends, and actionable recommendations.',
    inputSchema: {
      type: 'object',
      properties: {
        repositories: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of repository names to include in report.',
        },
        days_back: {
          type: 'number',
          description: 'Number of days to analyze. Default: 7',
        },
        include_recommendations: {
          type: 'boolean',
          description: 'Include actionable recommendations. Default: true',
        },
      },
    },
  },
];

// Create MCP server
const server = new Server(
  {
    name: 'mcp-pr-review-optimizer',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: any;

    switch (name) {
      case 'get_stale_prs':
        result = await getStalePRs(args as any);
        break;

      case 'get_review_metrics':
        result = await getReviewMetrics(args as any);
        break;

      case 'get_reviewer_workload':
        result = await getReviewerWorkload(args as any);
        break;

      case 'suggest_reviewers':
        result = await suggestReviewers(args as any);
        break;

      case 'analyze_review_bottlenecks':
        result = await analyzeReviewBottlenecks(args as any);
        break;

      case 'get_pr_review_history':
        result = await getPRReviewHistory(args as any);
        break;

      case 'generate_review_report':
        result = await generateReviewReport(args as any);
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Create Express app for HTTP transport
const app = express();
app.use(express.json());

// Create transport with session management
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: () => {
    // Generate a simple session ID for stateful connections
    return `session-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  },
});

// Hook up transport to Express routes
app.post('/mcp', (req, res) => {
  transport.handleRequest(req, res, req.body);
});

app.get('/mcp', (req, res) => {
  transport.handleRequest(req, res);
});

// Connect server to transport
async function main() {
  try {
    console.log('Starting MCP PR Review Optimizer Server...');
    console.log(`GitHub Organization: ${config.github.org}`);
    console.log(`Repositories: ${config.github.repos?.join(', ') || 'All'}`);
    console.log(`Reviewers: ${config.github.reviewers?.join(', ') || 'All'}`);

    await server.connect(transport);

    // Start HTTP server
    const port = config.server.port;
    const host = config.server.host;

    app.listen(port, host, () => {
      console.log(`\n✅ Server running on http://${host}:${port}`);
      console.log(`📍 MCP endpoint: http://${host}:${port}/mcp`);
      console.log('\nAvailable tools:');
      TOOLS.forEach(tool => {
        console.log(`  - ${tool.name}: ${tool.description}`);
      });
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\nShutting down server...');
  await server.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n\nShutting down server...');
  await server.close();
  process.exit(0);
});

// Start server
main();
