# Diff Share - Deployment Guide

This guide walks you through deploying the diff-share service to Cloudflare.

## Prerequisites

1. **Cloudflare Account** - Sign up at https://dash.cloudflare.com/sign-up
2. **Node.js/Bun** - Install Bun: `curl -fsSL https://bun.sh/install | bash`
3. **Wrangler CLI** - Install: `npm install -g wrangler`
4. **Git** - For cloning the repository

## Cloudflare Services Required

| Service | Purpose | Free Tier |
|---------|---------|-----------|
| Workers | API backend | 100,000 requests/day |
| R2 | Store HTML files | 10 GB storage |
| D1 | Metadata database | 5 GB storage |

## Step-by-Step Deployment

### 1. Clone and Setup

```bash
git clone git@github.com:KrabsWong/diff-share.git
cd diff-share

# Install dependencies
bun install
```

### 2. Configure Wrangler

Login to Cloudflare:
```bash
wrangler login
```

This will open a browser window to authorize Wrangler with your Cloudflare account.

### 3. Create D1 Database

```bash
wrangler d1 create diff-share-db
```

Output example:
```
✅ Successfully created DB 'diff-share-db'
Database ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Copy the Database ID and update `packages/worker/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "diff-share-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # <-- Paste here
```

### 4. Create R2 Bucket

```bash
wrangler r2 bucket create diff-share-files
```

### 5. Initialize Database Schema

```bash
cd packages/worker
wrangler d1 execute diff-share-db --file=./schema.sql
```

Verify the table was created:
```bash
wrangler d1 execute diff-share-db --command="SELECT name FROM sqlite_master WHERE type='table';"
```

### 6. Configure Public Access for R2

1. Go to Cloudflare Dashboard → R2
2. Click on `diff-share-files` bucket
3. Go to "Settings" tab
4. Enable "R2.dev subdomain" or configure custom domain
5. Copy the public URL (e.g., `https://pub-xxx.r2.dev`)

Update the URL generation in `packages/worker/src/index.ts`:

```javascript
function generatePublicUrl(requestUrl: string, hash: string): string {
  // Replace with your R2 public URL
  return `https://pub-xxx.r2.dev/${hash}.html`;
}
```

### 7. Deploy Worker

```bash
wrangler deploy
```

Your Worker will be deployed to:
```
https://diff-share-worker.your-account.workers.dev
```

### 8. Test the API

```bash
curl https://diff-share-worker.your-account.workers.dev/
```

Expected response:
```json
{
  "status": "ok",
  "service": "diff-share-worker",
  "version": "0.1.0"
}
```

Test upload:
```bash
curl -X POST https://diff-share-worker.your-account.workers.dev/api/upload \
  -H "Content-Type: application/json" \
  -d '{
    "diff": "+ added line\n- removed line",
    "mode": "working",
    "source": {},
    "metadata": {},
    "ttl": 24
  }'
```

### 9. Build and Configure CLI

```bash
cd packages/cli
bun run build
```

Update the default API URL in `packages/cli/src/index.ts`:

```typescript
.option('--api-url <url>', 'API endpoint URL', 'https://diff-share-worker.your-account.workers.dev')
```

Or set environment variable:
```bash
export DIFF_SHARE_API_URL=https://diff-share-worker.your-account.workers.dev
```

### 10. Install CLI Globally (Optional)

```bash
cd packages/cli
bun link
```

Now you can use `diff-share` command anywhere:
```bash
diff-share --help
```

## Post-Deployment Configuration

### Custom Domain (Recommended)

1. In Cloudflare Dashboard, go to Workers & Pages
2. Select your worker
3. Go to "Triggers" tab
4. Click "Add Custom Domain"
5. Enter your domain (e.g., `api.diff-share.com`)

### R2 Custom Domain

1. Go to R2 → diff-share-files bucket
3. Go to "Settings" tab
4. Click "Connect Domain"
5. Enter your domain (e.g., `files.diff-share.com`)
6. Update the public URL in worker code

### Environment Variables

For local development, create `.env` file:

```bash
# packages/worker/.env
DIFF_SHARE_API_URL=https://api.diff-share.com
```

For production secrets:
```bash
wrangler secret put SECRET_KEY
```

## Verification Checklist

- [ ] Worker deployed and responding
- [ ] D1 database created and schema applied
- [ ] R2 bucket created and public access enabled
- [ ] Cleanup cron job configured (runs every 6 hours)
- [ ] CLI built and API URL configured
- [ ] Test upload works and returns valid URL
- [ ] Generated HTML page displays correctly
- [ ] Expired files are cleaned up automatically

## Troubleshooting

### Worker deployment fails
```bash
# Check wrangler is logged in
wrangler whoami

# View logs
wrangler tail
```

### Database connection errors
- Verify `database_id` in wrangler.toml matches the created database
- Check database is in the same account as the worker

### R2 access denied
- Ensure R2 bucket is in the same account
- Check bucket permissions in Cloudflare Dashboard

### CORS errors
- Worker already has CORS enabled in code
- Check if request origin is blocked by Cloudflare firewall

## Updating the Service

After making code changes:

```bash
# Deploy new Worker version
cd packages/worker
wrangler deploy

# Rebuild CLI if changed
cd packages/cli
bun run build
```

## Monitoring

View Worker analytics:
```bash
wrangler tail
```

Or check Cloudflare Dashboard → Workers → diff-share-worker → Analytics

## Cost Estimation (Free Tier)

With Cloudflare's free tier, you can handle:
- 100,000 API requests/day
- 10 GB R2 storage
- 5 GB D1 storage

For a personal/small team use case, this is more than sufficient.

## Support

For issues or questions:
- GitHub Issues: https://github.com/KrabsWong/diff-share/issues
- Cloudflare Docs: https://developers.cloudflare.com/
