// Shared types between CLI and Worker

export interface DiffUploadRequest {
  diff: string;
  mode: 'working' | 'commit' | 'range' | 'base' | 'staged';
  source: {
    commit?: string;
    from?: string;
    to?: string;
    base?: string;
  };
  metadata: {
    title?: string;
    description?: string;
    repoName?: string;
    branch?: string;
  };
  ttl: number; // hours
}

export interface DiffUploadResponse {
  success: boolean;
  url: string;
  hash: string;
  expireAt: string;
  error?: string;
}

export interface DiffMetadata {
  hash: string;
  createdAt: string;
  expireAt: string;
  mode: string;
  title?: string;
  repoName?: string;
  branch?: string;
}

export interface CLIOptions {
  commit?: string;
  from?: string;
  to?: string;
  base?: string;
  staged?: boolean;
  title?: string;
  description?: string;
  ttl?: number;
  open?: boolean;
  copy?: boolean;
  raw?: boolean;
  apiUrl?: string;
}