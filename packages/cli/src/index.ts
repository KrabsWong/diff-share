#!/usr/bin/env node

import { Command } from 'commander';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import type { CLIOptions, DiffUploadRequest } from '../../shared/types';

const program = new Command();

// Read package.json
const packageJson = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8')
);

program
  .name('diff-share')
  .description('Share git diffs via temporary online links')
  .version(packageJson.version);

program
  .argument('[range]', 'Git range (e.g., abc123..def456)')
  .option('-c, --commit <hash>', 'Show specific commit')
  .option('--from <hash>', 'Range start commit')
  .option('--to <hash>', 'Range end commit (default: HEAD)')
  .option('-b, --base <branch>', 'Compare with base branch')
  .option('-s, --staged', 'Show staged changes only', false)
  .option('-t, --title <title>', 'Custom page title')
  .option('-d, --description <desc>', 'Additional description')
  .option('--ttl <hours>', 'Expiration time in hours', '24')
  .option('-o, --open', 'Auto-open in browser', false)
  .option('--copy', 'Copy link to clipboard', false)
  .option('--raw', 'Output raw URL only', false)
  .option('--api-url <url>', 'API endpoint URL', 'https://diff-share-worker.your-account.workers.dev')
  .action(async (rangeArg: string | undefined, options: CLIOptions) => {
    try {
      const result = await handleUpload(rangeArg, options);
      
      if (!result.success) {
        console.error('❌ Error:', result.error);
        process.exit(1);
      }

      if (options.raw) {
        console.log(result.url);
        return;
      }

      console.log('✅ Upload successful!');
      console.log('');
      console.log('🔗 Link:', result.url);
      console.log('🆔 Hash:', result.hash);
      console.log('⏰ Expires:', new Date(result.expireAt).toLocaleString());
      console.log('');

      if (options.copy) {
        await copyToClipboard(result.url);
        console.log('📋 Link copied to clipboard');
      }

      if (options.open) {
        await openBrowser(result.url);
        console.log('🌐 Opening in browser...');
      }

    } catch (error) {
      console.error('❌ Failed:', error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

async function handleUpload(rangeArg: string | undefined, options: CLIOptions) {
  // Parse git range argument (e.g., "abc123..def456")
  let from = options.from;
  let to = options.to || 'HEAD';
  
  if (rangeArg && rangeArg.includes('..')) {
    const parts = rangeArg.split('..');
    from = parts[0];
    to = parts[1] || 'HEAD';
  }

  // Determine mode and get diff
  const { diff, mode, source } = await getDiff({
    commit: options.commit,
    from,
    to,
    base: options.base,
    staged: options.staged,
  });

  if (!diff || diff.trim().length === 0) {
    throw new Error('No diff content found. Make sure you have changes to share.');
  }

  // Get git metadata
  const metadata = await getGitMetadata();
  
  // Override with CLI options
  if (options.title) metadata.title = options.title;
  if (options.description) metadata.description = options.description;

  // Build request
  const request: DiffUploadRequest = {
    diff,
    mode,
    source,
    metadata,
    ttl: parseInt(options.ttl || '24', 10),
  };

  // Upload
  const apiUrl = options.apiUrl || process.env.DIFF_SHARE_API_URL || 'https://diff-share-worker.your-account.workers.dev';
  
  const response = await fetch(`${apiUrl}/api/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return await response.json();
}

interface DiffOptions {
  commit?: string;
  from?: string;
  to?: string;
  base?: string;
  staged?: boolean;
}

async function getDiff(options: DiffOptions): Promise<{
  diff: string;
  mode: DiffUploadRequest['mode'];
  source: DiffUploadRequest['source'];
}> {
  const { commit, from, to, base, staged } = options;

  // Priority: commit > range (from/to) > base > staged > working
  if (commit) {
    return {
      diff: execGit(['show', commit]),
      mode: 'commit',
      source: { commit },
    };
  }

  if (from) {
    return {
      diff: execGit(['diff', `${from}..${to}`]),
      mode: 'range',
      source: { from, to },
    };
  }

  if (base) {
    return {
      diff: execGit(['diff', `${base}...HEAD`]),
      mode: 'base',
      source: { base },
    };
  }

  if (staged) {
    return {
      diff: execGit(['diff', '--staged']),
      mode: 'staged',
      source: {},
    };
  }

  // Default: working directory
  return {
    diff: execGit(['diff']),
    mode: 'working',
    source: {},
  };
}

function execGit(args: string[]): string {
  try {
    return execSync(`git ${args.join(' ')}`, {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
  } catch (error) {
    if (error instanceof Error && 'stdout' in error) {
      return (error as any).stdout || '';
    }
    throw error;
  }
}

async function getGitMetadata(): Promise<DiffUploadRequest['metadata']> {
  try {
    const repoName = execGit(['rev-parse', '--show-toplevel'])
      .trim()
      .split('/')
      .pop();
    
    const branch = execGit(['branch', '--show-current']).trim();
    
    return {
      repoName,
      branch,
    };
  } catch {
    return {};
  }
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    // macOS
    if (process.platform === 'darwin') {
      execSync(`echo ${JSON.stringify(text)} | pbcopy`);
      return;
    }
    // Linux
    if (process.platform === 'linux') {
      execSync(`echo ${JSON.stringify(text)} | xclip -selection clipboard`);
      return;
    }
    // Windows
    if (process.platform === 'win32') {
      execSync(`echo ${JSON.stringify(text)} | clip`);
      return;
    }
  } catch {
    // Silently fail if clipboard tool not available
  }
}

async function openBrowser(url: string): Promise<void> {
  try {
    const command = process.platform === 'darwin' ? 'open' : 
                   process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${command} ${url}`);
  } catch {
    // Silently fail if browser can't be opened
  }
}

program.parse();