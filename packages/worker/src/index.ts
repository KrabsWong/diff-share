import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DiffUploadRequest, DiffUploadResponse, DiffMetadata } from '../../../shared/types';

export interface Env {
  DB: D1Database;
  DIFF_BUCKET: R2Bucket;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

// Enable CORS
app.use('*', cors({
  origin: '*',
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// Health check
app.get('/', (c) => {
  return c.json({ 
    status: 'ok', 
    service: 'diff-share-worker',
    version: '0.1.0'
  });
});

// Upload endpoint
app.post('/api/upload', async (c) => {
  try {
    const body = await c.req.json<DiffUploadRequest>();
    
    // Validate request
    if (!body.diff || body.diff.trim().length === 0) {
      return c.json<DiffUploadResponse>({
        success: false,
        url: '',
        hash: '',
        expireAt: '',
        error: 'Diff content is required'
      }, 400);
    }

    // Generate hash
    const hash = await generateHash(body.diff);
    
    // Calculate expiration
    const ttl = body.ttl || 24;
    const now = new Date();
    const expireAt = new Date(now.getTime() + ttl * 60 * 60 * 1000);

    // Generate HTML
    const html = generateDiffPage(body, hash, now, expireAt);

    // Upload to R2
    await c.env.DIFF_BUCKET.put(`${hash}.html`, html, {
      httpMetadata: {
        contentType: 'text/html',
      },
    });

    // Store metadata in D1
    await c.env.DB.prepare(`
      INSERT INTO diffs (hash, created_at, expire_at, mode, title, repo_name, branch)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      hash,
      now.toISOString(),
      expireAt.toISOString(),
      body.mode,
      body.metadata?.title || null,
      body.metadata?.repoName || null,
      body.metadata?.branch || null
    ).run();

    // Generate URL
    const url = generatePublicUrl(c.req.url, hash);

    return c.json<DiffUploadResponse>({
      success: true,
      url,
      hash,
      expireAt: expireAt.toISOString(),
    });

  } catch (error) {
    console.error('Upload error:', error);
    return c.json<DiffUploadResponse>({
      success: false,
      url: '',
      hash: '',
      expireAt: '',
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// Cleanup endpoint (for manual trigger)
app.post('/api/cleanup', async (c) => {
  try {
    const deleted = await cleanupExpired(c.env);
    return c.json({ success: true, deleted });
  } catch (error) {
    console.error('Cleanup error:', error);
    return c.json({ success: false, error: String(error) }, 500);
  }
});

// Scheduled cleanup task
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Running scheduled cleanup...');
    await cleanupExpired(env);
    console.log('Cleanup completed');
  }
};

// Helper functions
async function generateHash(diff: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(diff + Date.now());
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function generatePublicUrl(requestUrl: string, hash: string): string {
  const url = new URL(requestUrl);
  // For production, use R2 public URL or custom domain
  // For now, return a placeholder that will be replaced with actual R2/CDN URL
  return `https://r2.diff-share.com/${hash}.html`;
}

function generateDiffPage(
  request: DiffUploadRequest, 
  hash: string, 
  createdAt: Date, 
  expireAt: Date
): string {
  const { diff, mode, metadata } = request;
  const title = metadata?.title || getDefaultTitle(mode, request.source);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Diff Share</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #0d1117;
      color: #c9d1d9;
      line-height: 1.6;
    }
    .header {
      background: #161b22;
      border-bottom: 1px solid #30363d;
      padding: 1rem 2rem;
    }
    .header h1 {
      font-size: 1.25rem;
      color: #f0f6fc;
      margin-bottom: 0.5rem;
    }
    .meta {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      font-size: 0.875rem;
      color: #8b949e;
    }
    .meta span {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    .badge {
      background: #238636;
      color: white;
      padding: 0.125rem 0.5rem;
      border-radius: 0.75rem;
      font-size: 0.75rem;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 2rem;
    }
    .info {
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 0.5rem;
      padding: 1rem;
      margin-bottom: 1.5rem;
    }
    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .expires {
      color: #f85149;
      font-size: 0.875rem;
    }
    .diff-container {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 0.5rem;
      overflow: hidden;
    }
    .diff-header {
      background: #21262d;
      padding: 0.75rem 1rem;
      border-bottom: 1px solid #30363d;
      font-size: 0.875rem;
      color: #8b949e;
    }
    .diff-content {
      padding: 1rem;
      overflow-x: auto;
    }
    .diff-line {
      font-family: 'SF Mono', Monaco, monospace;
      font-size: 0.875rem;
      line-height: 1.5;
      white-space: pre;
      padding: 0 0.5rem;
    }
    .diff-add { background: rgba(35, 134, 54, 0.2); color: #3fb950; }
    .diff-del { background: rgba(248, 81, 73, 0.2); color: #f85149; }
    .diff-info { color: #8b949e; }
    .diff-hunk { color: #58a6ff; }
    .footer {
      text-align: center;
      padding: 2rem;
      color: #8b949e;
      font-size: 0.875rem;
    }
    .footer a {
      color: #58a6ff;
      text-decoration: none;
    }
    @media (max-width: 768px) {
      .container { padding: 1rem; }
      .header { padding: 1rem; }
      .meta { flex-direction: column; gap: 0.5rem; }
    }
  </style>
</head>
<body>
  <header class="header">
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">
      <span><span class="badge">${mode}</span></span>
      ${metadata?.repoName ? `<span>📁 ${escapeHtml(metadata.repoName)}</span>` : ''}
      ${metadata?.branch ? `<span>🌿 ${escapeHtml(metadata.branch)}</span>` : ''}
      ${metadata?.description ? `<span>${escapeHtml(metadata.description)}</span>` : ''}
    </div>
  </header>
  
  <div class="container">
    <div class="info">
      <div class="info-row">
        <div>
          <strong>Hash:</strong> <code>${hash}</code>
          <br>
          <strong>Created:</strong> ${createdAt.toLocaleString()}
        </div>
        <div class="expires">
          ⏰ Expires: ${expireAt.toLocaleString()}
        </div>
      </div>
    </div>
    
    <div class="diff-container">
      <div class="diff-header">Diff Content</div>
      <div class="diff-content">
        ${formatDiff(diff)}
      </div>
    </div>
  </div>
  
  <footer class="footer">
    Generated by <a href="https://github.com/KrabsWong/diff-share">Diff Share</a>
  </footer>
</body>
</html>`;
}

function formatDiff(diff: string): string {
  return diff.split('\n').map(line => {
    let className = '';
    if (line.startsWith('+')) className = 'diff-add';
    else if (line.startsWith('-')) className = 'diff-del';
    else if (line.startsWith('@@')) className = 'diff-hunk';
    else if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) className = 'diff-info';
    
    return `<div class="diff-line ${className}">${escapeHtml(line)}</div>`;
  }).join('');
}

function escapeHtml(text: string): string {
  const div = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, m => div[m as keyof typeof div]);
}

function getDefaultTitle(mode: string, source: DiffUploadRequest['source']): string {
  switch (mode) {
    case 'working':
      return 'Uncommitted Changes';
    case 'commit':
      return `Commit ${source?.commit?.slice(0, 7)}`;
    case 'range':
      return `${source?.from?.slice(0, 7)}..${source?.to?.slice(0, 7)}`;
    case 'base':
      return `vs ${source?.base}`;
    case 'staged':
      return 'Staged Changes';
    default:
      return 'Git Diff';
  }
}

async function cleanupExpired(env: Env): Promise<number> {
  // Query expired records
  const { results } = await env.DB.prepare(`
    SELECT hash FROM diffs WHERE expire_at < datetime('now')
  `).all<{ hash: string }>();

  if (!results || results.length === 0) {
    return 0;
  }

  // Delete from R2
  for (const { hash } of results) {
    try {
      await env.DIFF_BUCKET.delete(`${hash}.html`);
      console.log(`Deleted expired file: ${hash}.html`);
    } catch (error) {
      console.error(`Failed to delete ${hash}.html:`, error);
    }
  }

  // Delete from D1
  await env.DB.prepare(`
    DELETE FROM diffs WHERE expire_at < datetime('now')
  `).run();

  console.log(`Cleaned up ${results.length} expired diffs`);
  return results.length;
}