import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DiffUploadRequest, DiffUploadResponse } from '../../../shared/types';
import { generateDiffPage } from './templates/diff-page';

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
    const html = generateDiffPage({
      request: body,
      hash,
      createdAt: now,
      expireAt,
    });

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
  const r2PublicUrl = env.R2_PUBLIC_URL || 'https://pub-xxxxxxxx.r2.dev';
  return `${r2PublicUrl}/${hash}.html`;
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
    const request = {
      diff: row.diff_content,
      mode: row.mode,
      source: {} as DiffUploadRequest['source'],
      metadata: {
        title: row.title || undefined,
        repoName: row.repo_name || undefined,
        branch: row.branch || undefined
      },
      ttl: 24,
    };

    // Regenerate HTML
    const html = generateDiffPage({
      request,
      hash: row.hash,
      createdAt: new Date(row.created_at),
      expireAt: new Date(row.expire_at),
    });

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