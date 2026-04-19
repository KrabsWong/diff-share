# Diff Share

A lightweight service for sharing local git diffs via temporary online links.

## Problem

When working on local git repositories with uncommitted changes, it's difficult to:
- View diffs on mobile devices when away from the computer
- Share work-in-progress changes with teammates quickly
- Review code changes without pushing to remote

## Solution

Diff Share provides a simple way to:
1. Upload local git diffs to a temporary online storage
2. Generate shareable links that expire after a set time
3. View diffs beautifully formatted in the browser

## Features

- **One-command sharing**: Simple CLI to upload and share diffs
- **Temporary storage**: Auto-expire links (configurable: 1h, 24h, 7d)
- **Mobile-friendly**: Responsive web interface for viewing on any device
- **Private by default**: Links are unguessable random tokens
- **No GitHub required**: Works with any local git repo

## Usage

### CLI Tool

```bash
# Share current working directory changes
diff-share

# Share with custom expiration
diff-share --expire 7d

# Share specific files
diff-share --files src/*.ts
```

### Web Interface

Open the shared link in any browser:
```
https://diff-share.example.com/view/abc123def
```

## Architecture

```
┌─────────────┐     HTTP POST      ┌─────────────┐
│   CLI Tool  │ ─────────────────► │   Server    │
│  (Upload)   │                    │  (Store)    │
└─────────────┘                    └──────┬──────┘
                                          │
                                          │ Generate URL
                                          ▼
                                   ┌─────────────┐
                                   │   Browser   │
                                   │  (View)     │
                                   └─────────────┘
```

## Tech Stack

- **Backend**: Node.js / Bun + Hono
- **Storage**: In-memory with Redis for production
- **Frontend**: Simple HTML + CSS (no framework needed)
- **CLI**: Bun shell script

## Development

```bash
# Install dependencies
bun install

# Start development server
bun run dev

# Run tests
bun test
```

## License

MIT

## Author

KrabsWong
