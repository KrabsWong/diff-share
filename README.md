# Diff Share

A lightweight service for sharing local git diffs via temporary online links.

## Problem

When working on local git repositories with uncommitted changes, it's difficult to:
- View diffs on mobile devices when away from the computer
- Share work-in-progress changes with teammates quickly
- Review code changes without pushing to remote
- Share specific commit changes or compare between versions

## Solution

Diff Share provides a simple way to:
1. Upload local git diffs to a temporary online storage
2. Generate shareable links that expire after a set time
3. View diffs beautifully formatted in the browser

## Architecture

```mermaid
flowchart TB
    subgraph Local["Local Machine"]
        CLI[CLI Tool]
        Git[(Git Repo)]
    end

    subgraph Cloudflare["Cloudflare Platform"]
        Worker[Worker<br>API Handler]
        D1[(D1<br>Metadata)]
        R2[(R2<br>HTML Files)]
    end

    subgraph User["Users"]
        Browser[Browser/Mobile]
    end

    CLI -->|1. POST /api/upload<br>diff + metadata| Worker
    CLI -.->|read diff| Git

    Worker -->|2a. Store metadata| D1
    Worker -->|2b. Generate HTML| HTML[HTML Generator]
    HTML -->|3. Upload static file| R2

    Worker -->|4. Return CDN URL| CLI
    Browser -->|5. GET /{hash}.html| R2
```

### Data Flow

1. **CLI Upload**: User runs `diff-share` command with various options
2. **Worker Process**: Cloudflare Worker receives diff, generates HTML page
3. **Storage**: Metadata saved to D1, HTML file uploaded to R2 bucket
4. **Access**: User receives CDN link to view the diff

## Features

- **Multiple Diff Sources**:
  - Current uncommitted changes
  - Specific commit (`--commit`)
  - Range between commits (`--from/--to` or `commitA..commitB`)
  - Branch comparison (`--base`)
  - Staged changes only (`--staged`)

- **Flexible Expiration**: Configure TTL per upload (1h, 24h, 7d, 30d)
- **Auto Cleanup**: Expired files automatically deleted from R2
- **Mobile-friendly**: Responsive web interface
- **Private by default**: Unguessable hash-based URLs
- **No GitHub required**: Works with any local git repo

## Usage

### CLI Commands

```bash
# Current uncommitted changes (working directory)
diff-share

# Specific commit
diff-share --commit abc123
diff-share -c HEAD~3

# Compare two commits
diff-share --from abc123 --to def456
diff-share abc123..def456

# Compare current branch with base branch
diff-share --base main

# Staged changes only
diff-share --staged

# With custom options
diff-share --commit HEAD~5 --ttl 7d --title "Revert changes" --open
```

### CLI Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--commit` | `-c` | Show specific commit | - |
| `--from` | - | Range start commit | - |
| `--to` | - | Range end commit | `HEAD` |
| `--base` | - | Compare with base branch | - |
| `--staged` | - | Staged changes only | false |
| `--title` | `-t` | Custom page title | Auto-generated |
| `--description` | `-d` | Additional description | - |
| `--ttl` | - | Expiration in hours | 24 |
| `--open` | `-o` | Auto-open in browser | false |
| `--copy` | - | Copy link to clipboard | false |

### Web Interface

Open the shared link in any browser:
```
https://r2.diff-share.com/a3f7b2c8d9e1f5a2.html
```

## Tech Stack

| Component | Technology |
|-----------|------------|
| **API Backend** | Cloudflare Workers (Hono) |
| **Storage** | Cloudflare R2 (HTML files) |
| **Metadata** | Cloudflare D1 (SQLite) |
| **CDN** | Cloudflare CDN (global edge) |
| **CLI** | Bun + Commander.js |
| **HTML Gen** | Syntax highlighting + templates |

## Project Structure

```
diff-share/
├── packages/
│   ├── cli/           # CLI tool
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── git.ts
│   │   │   └── upload.ts
│   │   └── package.json
│   └── worker/        # Cloudflare Worker
│       ├── src/
│       │   ├── index.ts
│       │   ├── routes.ts
│       │   ├── html-generator.ts
│       │   └── cleanup.ts
│       └── wrangler.toml
├── shared/            # Shared types and utils
└── README.md
```

## Development

### Prerequisites

- [Bun](https://bun.sh/) installed
- Cloudflare account with Workers, R2, D1 enabled

### Setup

```bash
# Install dependencies
bun install

# Configure Cloudflare credentials
wrangler login

# Create D1 database
wrangler d1 create diff-share-db

# Create R2 bucket
wrangler r2 bucket create diff-share-files
```

### Local Development

```bash
# Start Worker locally
cd packages/worker
bun run dev

# Test CLI (in another terminal)
cd packages/cli
bun run build
./dist/cli upload --help
```

### Deployment

```bash
# Deploy Worker
cd packages/worker
wrangler deploy

# Publish CLI to npm (optional)
cd packages/cli
npm publish
```

## Expiration & Cleanup

### Strategy

1. **Per-file expiration**: Each upload has exact expiration timestamp stored in D1
2. **Cron cleanup**: Worker runs every 6 hours to delete expired files
3. **R2 lifecycle**: 30-day fallback rule to prevent unlimited growth

```javascript
// Worker scheduled task
export default {
  async scheduled(controller, env, ctx) {
    // Query expired records from D1
    const expired = await env.DB.prepare(`
      SELECT hash FROM diffs WHERE expire_at < datetime('now')
    `).all();
    
    // Batch delete from R2
    for (const { hash } of expired.results) {
      await env.DIFF_BUCKET.delete(`${hash}.html`);
    }
    
    // Clean up D1 records
    await env.DB.prepare(`
      DELETE FROM diffs WHERE expire_at < datetime('now')
    `).run();
  }
};
```

## License

MIT

## Author

KrabsWong
