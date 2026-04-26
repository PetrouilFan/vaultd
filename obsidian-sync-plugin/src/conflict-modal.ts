import {
  Modal,
  Notice,
  TFile,
  Workspace,
  WorkspaceLeaf,
} from 'obsidian';

export interface ConflictModalOptions {
  path: string;
  localContent: string;
  remoteContent: string;
  onResolve: (resolution: 'local' | 'remote' | 'both') => void;
}

interface DiffPatch {
  diffs: Array<[number, string]>;
  emsns: number[];
}

export class ConflictModal extends Modal {
  private options: ConflictModalOptions;
  private diffResult: DiffPatch | null = null;
  private useUnified = false;

  constructor(app: any, options: ConflictModalOptions) {
    super(app);
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;

    contentEl.empty();
    contentEl.addClass('sync-conflict-modal');

    const header = contentEl.createDiv('modal-header');
    header.createEl('h2', { text: 'Conflict Detected' });

    const pathEl = contentEl.createDiv('conflict-path');
    pathEl.createEl('strong', { text: 'File: ' });
    pathEl.createEl('span', { text: this.options.path });

    const description = contentEl.createDiv('conflict-description');
    description.textContent = 'This file has been modified both locally and remotely. Choose how to resolve the conflict:';

    const controls = contentEl.createDiv('diff-controls');
    controls.createEl('button', {
      text: this.useUnified ? 'Show Side-by-Side' : 'Show Unified',
      cls: 'diff-toggle-btn',
    }).addEventListener('click', () => {
      this.useUnified = !this.useUnified;
      this.renderDiff();
    });

    const diffContainer = contentEl.createDiv('diff-container');
    this.renderDiffInContainer(diffContainer);

    const actions = contentEl.createDiv('modal-actions');

    const keepMineBtn = actions.createEl('button', {
      text: 'Keep Mine',
      cls: 'mod-cta',
    });
    keepMineBtn.addEventListener('click', () => {
      this.options.onResolve('local');
      new Notice('Kept local version');
      this.close();
    });

    const keepTheirsBtn = actions.createEl('button', {
      text: 'Keep Theirs',
    });
    keepTheirsBtn.addEventListener('click', () => {
      this.options.onResolve('remote');
      new Notice('Kept remote version');
      this.close();
    });

    const keepBothBtn = actions.createEl('button', {
      text: 'Keep Both',
    });
    keepBothBtn.addEventListener('click', async () => {
      await this.saveBothVersions();
      this.options.onResolve('both');
      this.close();
    });

    const openBothBtn = actions.createEl('button', {
      text: 'Open Both',
    });
    openBothBtn.addEventListener('click', () => {
      this.openBothVersions();
      this.close();
    });
  }

  private renderDiffInContainer(container: HTMLElement): void {
    this.diffResult = this.computeDiff(this.options.localContent, this.options.remoteContent);

    if (this.useUnified) {
      this.renderUnifiedDiff(container);
    } else {
      this.renderSideBySideDiff(container);
    }
  }

  private computeDiff(text1: string, text2: string): DiffPatch {
    const diffs: Array<[number, string]> = [];
    const lines1 = text1.split('\n');
    const lines2 = text2.split('\n');

    const lcs = this.computeLCS(lines1, lines2);

    let i = 0;
    let j = 0;
    let k = 0;

    while (i < lines1.length || j < lines2.length) {
      if (k < lcs.length && i < lines1.length && j < lines2.length &&
          lines1[i] === lcs[k] && lines2[j] === lcs[k]) {
        diffs.push([0, lines1[i]]);
        i++;
        j++;
        k++;
      } else if (i < lines1.length && (k >= lcs.length || lines1[i] !== lcs[k])) {
        diffs.push([-1, lines1[i]]);
        i++;
      } else if (j < lines2.length && (k >= lcs.length || lines2[j] !== lcs[k])) {
        diffs.push([1, lines2[j]]);
        j++;
      }
    }

    return { diffs, emsns: [] };
  }

  private computeLCS(arr1: string[], arr2: string[]): string[] {
    const m = arr1.length;
    const n = arr2.length;
    const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (arr1[i - 1] === arr2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const lcs: string[] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (arr1[i - 1] === arr2[j - 1]) {
        lcs.unshift(arr1[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return lcs;
  }

  private renderUnifiedDiff(container: HTMLElement): void {
    if (!this.diffResult) return;

    const diffView = container.createDiv('unified-diff');
    let lineNum = 1;

    for (const [type, text] of this.diffResult.diffs) {
      const line = diffView.createDiv('diff-line');

      const numSpan = line.createSpan('line-number');
      numSpan.textContent = String(lineNum).padStart(4, ' ');

      const prefixSpan = line.createSpan('diff-prefix');
      if (type === 0) prefixSpan.textContent = ' ';
      else if (type === -1) prefixSpan.textContent = '-';
      else if (type === 1) prefixSpan.textContent = '+';

      const contentSpan = line.createSpan('diff-content');
      contentSpan.textContent = text;

      if (type === -1) {
        line.addClass('deletion');
        contentSpan.addClass('text-del');
      } else if (type === 1) {
        line.addClass('addition');
        contentSpan.addClass('text-add');
      }

      lineNum++;
    }
  }

  private renderSideBySideDiff(container: HTMLElement): void {
    if (!this.diffResult) return;

    const sideBySide = container.createDiv('side-by-side-diff');

    const leftPanel = sideBySide.createDiv('diff-panel left');
    leftPanel.createEl('h3', { text: 'Local (Yours)' });

    const rightPanel = sideBySide.createDiv('diff-panel right');
    rightPanel.createEl('h3', { text: 'Remote (Theirs)' });

    const leftContent = leftPanel.createDiv('diff-content');
    const rightContent = rightPanel.createDiv('diff-content');

    for (const [type, text] of this.diffResult.diffs) {
      if (type === 0) {
        const leftLine = leftContent.createDiv('diff-line');
        leftLine.createSpan('line-text').textContent = text;
        leftLine.addClass('unchanged');

        const rightLine = rightContent.createDiv('diff-line');
        rightLine.createSpan('line-text').textContent = text;
        rightLine.addClass('unchanged');
      } else if (type === -1) {
        const leftLine = leftContent.createDiv('diff-line deletion');
        leftLine.createSpan('line-text').textContent = text;
        leftLine.addClass('text-del');
      } else if (type === 1) {
        const rightLine = rightContent.createDiv('diff-line addition');
        rightLine.createSpan('line-text').textContent = text;
        rightLine.addClass('text-add');
      }
    }
  }

  private renderDiff(): void {
    const container = this.contentEl.querySelector('.diff-container');
    if (container) {
      container.empty();
      this.renderDiffInContainer(container as HTMLElement);
    }
  }

  private async saveBothVersions(): Promise<void> {
    const pathParts = this.options.path.split('.');
    const ext = pathParts.pop();
    const baseName = pathParts.join('.');
    const date = new Date().toISOString().split('T')[0];
    const newPath = `${baseName}.conflicted-${date}.${ext}`;

    try {
      await this.app.vault.create(newPath, this.options.remoteContent);
      new Notice(`Created conflict file: ${newPath}`);
    } catch (e) {
      console.error('Failed to create conflict file:', e);
      new Notice('Failed to create conflict file');
    }
  }

  private openBothVersions(): void {
    const localFile = this.app.vault.getAbstractFileByPath(this.options.path);
    if (localFile instanceof TFile) {
      this.app.workspace.openLinkText(this.options.path, this.options.path);
    }

    const pathParts = this.options.path.split('.');
    const ext = pathParts.pop();
    const baseName = pathParts.join('.');
    const date = new Date().toISOString().split('T')[0];
    const remotePath = `${baseName}.conflicted-${date}.${ext}`;

    const remoteFile = this.app.vault.getAbstractFileByPath(remotePath);
    if (remoteFile instanceof TFile) {
      this.app.workspace.openLinkText(remotePath, remotePath);
    }
  }

  onClose(): void {
    const modalEl = this.contentEl.querySelector('.sync-conflict-modal');
    if (modalEl) {
      modalEl.remove();
    }
    super.onClose();
  }
}