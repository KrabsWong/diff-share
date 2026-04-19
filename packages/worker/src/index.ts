import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DiffUploadRequest, DiffUploadResponse, DiffMetadata } from '../../../shared/types';

export interface Env {
  DB: D1Database;
  DIFF_BUCKET: R2Bucket;
  ENVIRONMENT: string;
  R2_PUBLIC_URL: string;
  REGENERATE_TOKEN?: string;  // Optional token for authentication
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

    // Store metadata and diff content in D1
    await c.env.DB.prepare(`
      INSERT INTO diffs (hash, created_at, expire_at, mode, title, repo_name, branch, diff_content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      hash,
      now.toISOString(),
      expireAt.toISOString(),
      body.mode,
      body.metadata?.title || null,
      body.metadata?.repoName || null,
      body.metadata?.branch || null,
      body.diff
    ).run();

    // Generate URL
    const url = generatePublicUrl(c.req.url, hash, c.env);

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

// Regenerate HTML endpoint - useful after deploying new templates
app.post('/api/regenerate', async (c) => {
  try {
    // Simple token authentication (optional)
    const authHeader = c.req.header('Authorization');
    const expectedToken = c.env.REGENERATE_TOKEN;
    
    if (expectedToken) {
      const providedToken = authHeader?.replace('Bearer ', '');
      if (providedToken !== expectedToken) {
        return c.json({ 
          success: false, 
          error: 'Unauthorized. Set REGENERATE_TOKEN in wrangler.toml and provide it as Bearer token.' 
        }, 401);
      }
    }

    const body = await c.req.json<{ hash?: string; all?: boolean }>();
    
    if (body.hash) {
      // Regenerate single diff
      const result = await regenerateSingle(c.env, body.hash);
      return c.json(result);
    } else if (body.all) {
      // Regenerate all unexpired diffs
      const results = await regenerateAll(c.env);
      return c.json({
        success: true,
        total: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
        details: results
      });
    } else {
      return c.json({
        success: false,
        error: 'Please provide either "hash" to regenerate a specific diff, or "all: true" to regenerate all unexpired diffs'
      }, 400);
    }
  } catch (error) {
    console.error('Regenerate error:', error);
    return c.json({ 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }, 500);
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

function generatePublicUrl(_requestUrl: string, hash: string, env: Env): string {
  // Use R2 public URL from environment variable or construct from bucket
  // Format: https://pub-<id>.r2.dev
  const r2PublicUrl = env.R2_PUBLIC_URL || 'https://pub-xxxxxxxx.r2.dev';
  return `${r2PublicUrl}/${hash}.html`;
}

function generateDiffPage(
  request: DiffUploadRequest,
  hash: string,
  createdAt: Date,
  expireAt: Date
): string {
  const { diff, mode, metadata } = request;
  const title = metadata?.title || getDefaultTitle(mode, request.source);
  // Escape diff content for safe insertion into JavaScript string
  const escapedDiff = JSON.stringify(diff);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Diff Share</title>
  <!-- diff2html CSS -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/css/diff2html.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace;
      background: #ffffff;
      color: #24292f;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      background: #f6f8fa;
      border-bottom: 1px solid #d0d7de;
      padding: 1rem 2rem;
    }
    .header h1 {
      font-size: 1.25rem;
      color: #1f2328;
      margin-bottom: 0.5rem;
    }
    .meta {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      font-size: 0.875rem;
      color: #656d76;
    }
    .meta span {
      display: flex;
      align-items: center;
      gap: 0.25rem;
    }
    .badge {
      background: #2da44e;
      color: white;
      padding: 0.125rem 0.5rem;
      border-radius: 0.75rem;
      font-size: 0.75rem;
    }
    .container {
      flex: 1;
      max-width: 100%;
      margin: 0 auto;
      padding: 1rem;
      width: 100%;
    }
    .info {
      background: #f6f8fa;
      border: 1px solid #d0d7de;
      border-radius: 0.5rem;
      padding: 1rem;
      margin-bottom: 1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .expires {
      color: #cf222e;
      font-size: 0.875rem;
    }
    .diff-wrapper {
      background: #ffffff;
      border: 1px solid #d0d7de;
      border-radius: 0.5rem;
      overflow: hidden;
    }
    /* Override diff2html styles for light theme */
    .d2h-wrapper {
      background: #ffffff;
    }
    .d2h-file-header {
      background: #f6f8fa;
      border-bottom: 1px solid #d0d7de;
    }
    .d2h-file-name {
      color: #24292f;
    }
    
    /* Side-by-side mode background */
    .d2h-side-by-side {
      background: #ffffff;
    }
    .d2h-side-by-side .d2h-code-side {
      background: #ffffff;
    }
    .d2h-side-by-side .d2h-code-wrapper {
      background: #ffffff;
    }
    
    /* Left panel (original) background */
    .d2h-side-by-side .d2h-code-side:first-child {
      background: #ffffff;
    }
    
    /* Right panel (modified) background */
    .d2h-side-by-side .d2h-code-side:last-child {
      background: #ffffff;
    }
    
    /* Table cells in side-by-side mode */
    .d2h-side-by-side td {
      background: #ffffff;
      color: #24292f;
    }
    
    /* Code lines */
    .d2h-code-line {
      color: #24292f;
      background: transparent;
    }
    .d2h-code-side-line {
      color: #24292f;
      background: transparent;
    }
    
    /* Line numbers */
    .d2h-code-linenumber {
      background: #f6f8fa;
      color: #656d76;
      border-right: 1px solid #d0d7de;
    }
    
    /* Info rows */
    .d2h-info {
      background: #ffffff;
      color: #656d76;
    }
    
    /* Deleted lines - light red background */
    .d2h-del {
      background-color: rgba(255, 200, 200, 0.4);
    }
    .d2h-del .d2h-code-linenumber {
      background-color: rgba(255, 200, 200, 0.6);
      border-right-color: rgba(207, 34, 46, 0.4);
    }
    
    /* Inserted lines - light green background */
    .d2h-ins {
      background-color: rgba(200, 255, 200, 0.4);
    }
    .d2h-ins .d2h-code-linenumber {
      background-color: rgba(200, 255, 200, 0.6);
      border-right-color: rgba(45, 164, 78, 0.4);
    }
    
    /* Inline changes */
    .d2h-code-line del,
    .d2h-code-side-line del {
      background-color: rgba(255, 150, 150, 0.6);
    }
    .d2h-code-line ins,
    .d2h-code-side-line ins {
      background-color: rgba(150, 255, 150, 0.6);
    }
    
    /* File wrapper */
    .d2h-file-wrapper {
      border: 1px solid #d0d7de;
      border-radius: 0.375rem;
      margin-bottom: 1rem;
      background: #ffffff;
    }
    
    .d2h-file-collapse {
      display: none;
    }
    .view-toggle {
      background: #f6f8fa;
      border: 1px solid #d0d7de;
      color: #24292f;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      cursor: pointer;
      font-size: 0.875rem;
      margin-bottom: 1rem;
    }
    .view-toggle:hover {
      background: #e8ecf1;
    }
    .footer {
      text-align: center;
      padding: 1rem;
      color: #656d76;
      font-size: 0.875rem;
      background: #f6f8fa;
      border-top: 1px solid #d0d7de;
    }
    .footer a {
      color: #58a6ff;
      text-decoration: none;
    }
    @media (max-width: 768px) {
      .container { padding: 0.5rem; }
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
    </div>
  </header>

  <div class="container">
    <div class="info">
      <div>
        <strong>Hash:</strong> <code>${hash}</code>
        <span style="margin-left: 1rem;"><strong>Created:</strong> ${createdAt.toLocaleString()}</span>
      </div>
      <div class="expires">
        ⏰ Expires: ${expireAt.toLocaleString()}
      </div>
    </div>

    <button class="view-toggle" onclick="toggleView()">切换视图 (Side-by-side / Line-by-line)</button>

    <div id="diff-container" class="diff-wrapper">
      <div style="padding: 2rem; text-align: center; color: #656d76;">加载 diff...</div>
    </div>
  </div>

  <footer class="footer">
    Generated by <a href="https://github.com/KrabsWong/diff-share">Diff Share</a>
  </footer>

  <!-- diff2html JS -->
  <script src="https://cdn.jsdelivr.net/npm/diff2html@3.4.48/bundles/js/diff2html-ui.min.js"></script>
  <script>
    const diffString = ${escapedDiff};
    let currentOutputFormat = 'side-by-side';

    function renderDiff() {
      const targetElement = document.getElementById('diff-container');
      const configuration = {
        drawFileList: true,
        matching: 'lines',
        matchWordsThreshold: 0.25,
        maxLineSizeInBlockForComparison: 200,
        outputFormat: currentOutputFormat,
        synchronisedScroll: true,
        highlight: true,
        renderNothingWhenEmpty: false
      };

      const diff2htmlUi = new Diff2HtmlUI(targetElement, diffString, configuration);
      diff2htmlUi.draw();
    }

    function toggleView() {
      currentOutputFormat = currentOutputFormat === 'side-by-side' ? 'line-by-line' : 'side-by-side';
      renderDiff();
    }

    // Initial render
    renderDiff();
  </script>
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

// Regenerate a single diff's HTML
async function regenerateSingle(env: Env, hash: string): Promise<{ success: boolean; hash: string; error?: string }> {
  try {
    // Fetch diff data from D1
    const row = await env.DB.prepare(`
      SELECT hash, created_at, expire_at, mode, title, repo_name, branch, diff_content
      FROM diffs
      WHERE hash = ? AND expire_at > datetime('now')
    `).bind(hash).first<{
      hash: string;
      created_at: string;
      expire_at: string;
      mode: string;
      title: string | null;
      repo_name: string | null;
      branch: string | null;
      diff_content: string;
    }>();

    if (!row) {
      return { success: false, hash, error: 'Diff not found or expired' };
    }

    // Reconstruct request object
    const request: DiffUploadRequest = {
      diff: row.diff_content,
      mode: row.mode as DiffUploadRequest['mode'],
      metadata: {
        title: row.title || undefined,
        repoName: row.repo_name || undefined,
        branch: row.branch || undefined
      }
    };

    // Regenerate HTML
    const html = generateDiffPage(
      request,
      row.hash,
      new Date(row.created_at),
      new Date(row.expire_at)
    );

    // Upload to R2
    await env.DIFF_BUCKET.put(`${hash}.html`, html, {
      httpMetadata: {
        contentType: 'text/html',
      },
    });

    console.log(`Regenerated HTML for hash: ${hash}`);
    return { success: true, hash };
  } catch (error) {
    console.error(`Failed to regenerate ${hash}:`, error);
    return { 
      success: false, 
      hash, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    };
  }
}

// Regenerate all unexpired diffs
async function regenerateAll(env: Env): Promise<Array<{ success: boolean; hash: string; error?: string }>> {
  // Query all unexpired diffs
  const { results } = await env.DB.prepare(`
    SELECT hash FROM diffs WHERE expire_at > datetime('now')
  `).all<{ hash: string }>();

  if (!results || results.length === 0) {
    return [];
  }

  const results_array: Array<{ success: boolean; hash: string; error?: string }> = [];
  
  // Process sequentially to avoid overwhelming the system
  for (const { hash } of results) {
    const result = await regenerateSingle(env, hash);
    results_array.push(result);
  }

  console.log(`Regenerated ${results_array.filter(r => r.success).length}/${results_array.length} diffs`);
  return results_array;
}