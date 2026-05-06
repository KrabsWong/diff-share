interface DiffSource {
  commit?: string;
  from?: string;
  to?: string;
  base?: string;
}

interface DiffMetadata {
  title?: string;
  repoName?: string;
  branch?: string;
}

interface DiffRequest {
  diff: string;
  mode: string;
  source?: DiffSource;
  metadata?: DiffMetadata;
}

export interface DiffPageParams {
  request: DiffRequest;
  hash: string;
  createdAt: Date;
  expireAt: Date;
}

export function generateDiffPage(params: DiffPageParams): string {
  const { request, hash, createdAt, expireAt } = params;
  const { diff, mode, metadata } = request;
  const title = metadata?.title || getDefaultTitle(mode, request.source);
  const escapedDiff = JSON.stringify(diff);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} - Diff Share</title>
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
    .d2h-wrapper { background: #ffffff; }
    .d2h-file-header { background: #f6f8fa; border-bottom: 1px solid #d0d7de; }
    .d2h-file-name { color: #24292f; }
    .d2h-side-by-side { background: #ffffff; }
    .d2h-side-by-side .d2h-code-side { background: #ffffff; }
    .d2h-side-by-side .d2h-code-wrapper { background: #ffffff; }
    .d2h-side-by-side .d2h-code-side:first-child { background: #ffffff; }
    .d2h-side-by-side .d2h-code-side:last-child { background: #ffffff; }
    .d2h-side-by-side td { background: #ffffff; color: #24292f; }
    .d2h-code-line { color: #24292f; background: transparent; }
    .d2h-code-side-line { color: #24292f; background: transparent; }
    .d2h-code-linenumber { background: #f6f8fa; color: #656d76; border-right: 1px solid #d0d7de; }
    .d2h-info { background: #ffffff; color: #656d76; }
    .d2h-del { background-color: rgba(255, 200, 200, 0.4); }
    .d2h-del .d2h-code-linenumber { background-color: rgba(255, 200, 200, 0.6); border-right-color: rgba(207, 34, 46, 0.4); }
    .d2h-ins { background-color: rgba(200, 255, 200, 0.4); }
    .d2h-ins .d2h-code-linenumber { background-color: rgba(200, 255, 200, 0.6); border-right-color: rgba(45, 164, 78, 0.4); }
    .d2h-code-line del, .d2h-code-side-line del { background-color: rgba(255, 150, 150, 0.6); }
    .d2h-code-line ins, .d2h-code-side-line ins { background-color: rgba(150, 255, 150, 0.6); }
    .d2h-file-wrapper {
      border: 1px solid #d0d7de;
      border-radius: 0.375rem;
      margin-bottom: 1rem;
      background: #ffffff;
    }
    .d2h-file-collapse { display: none; }
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
    .view-toggle:hover { background: #e8ecf1; }
    .footer {
      text-align: center;
      padding: 1rem;
      color: #656d76;
      font-size: 0.875rem;
      background: #f6f8fa;
      border-top: 1px solid #d0d7de;
    }
    .footer a { color: #58a6ff; text-decoration: none; }
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

    renderDiff();
  </script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

function getDefaultTitle(mode: string, source?: DiffSource): string {
  switch (mode) {
    case 'working': return 'Uncommitted Changes';
    case 'commit': return `Commit ${source?.commit?.slice(0, 7)}`;
    case 'range': return `${source?.from?.slice(0, 7)}..${source?.to?.slice(0, 7)}`;
    case 'base': return `vs ${source?.base}`;
    case 'staged': return 'Staged Changes';
    default: return 'Git Diff';
  }
}