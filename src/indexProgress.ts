import * as path from 'path';
import * as vscode from 'vscode';
import { IndexProgress, ShaderWorkspaceIndex } from './workspaceIndex';

interface ProgressJob {
  state: IndexProgress;
  timer?: ReturnType<typeof setTimeout>;
  report?: vscode.Progress<{message?: string; increment?: number}>;
  finish?: () => void;
  percentage: number;
}

/** Status is immediate; notifications appear only for jobs lasting at least 350 ms. */
export class ShaderIndexProgress implements vscode.Disposable {
  private readonly jobs = new Map<number, ProgressJob>();
  private readonly subscriptions: vscode.Disposable[];
  public readonly status: vscode.StatusBarItem;

  public constructor(private readonly index: ShaderWorkspaceIndex) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
    this.status.command = 'shaderNavigator.showProgress';
    this.subscriptions = [
      this.status,
      index.onDidProgress(state => this.update(state)),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
      vscode.commands.registerCommand('shaderNavigator.showProgress', () => {
        const job = [...this.jobs.values()].find(value => !value.state.background) ?? [...this.jobs.values()][0];
        if (job) { this.showNotification(job); }
        else { void vscode.commands.executeCommand('shaderNavigator.diagnose'); }
      })
    ];
    this.updateStatus();
  }

  private message(state: IndexProgress): string {
    if (state.phase === 'restoring') { return '恢复磁盘缓存 ' + state.completed + '/' + state.total; }
    if (state.phase === 'discovering') { return '正在发现 Shader 文件…'; }
    const phase = state.phase === 'includes' ? '加载 include' : '扫描文件';
    return phase + ' ' + state.completed + '/' + state.total + (state.file ? ' · ' + path.basename(state.file) : '');
  }

  private update(state: IndexProgress): void {
    let job = this.jobs.get(state.id);
    if (state.phase === 'done' || state.phase === 'cancelled' || state.phase === 'failed') {
      if (job) {
        if (job.timer) { clearTimeout(job.timer); }
        if (state.phase === 'done') { job.report?.report({increment:100-job.percentage,message:'完成'}); }
        job.finish?.(); this.jobs.delete(state.id);
      }
      this.updateStatus(); return;
    }
    if (!job) {
      job = { state, percentage: 0 }; this.jobs.set(state.id, job);
      const currentJob = job;
      job.timer = setTimeout(() => { currentJob.timer = undefined; if (this.jobs.has(state.id)) { this.showNotification(currentJob); } }, 350);
    }
    job.state = state;
    const next = state.phase === 'discovering' ? 0 : Math.max(job.percentage, Math.min(99, state.completed / Math.max(1,state.total) * 99));
    job.report?.report({message:this.message(state),increment:next-job.percentage});
    job.percentage = next;
    this.updateStatus();
  }

  private showNotification(job: ProgressJob): void {
    if (job.finish) { return; }
    void vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:job.state.title,cancellable:!!job.state.cancel}, (report,cancellation) => {
      let cancel: vscode.Disposable | undefined;
      return new Promise<void>(resolve => {
      job.report = report; job.finish = resolve;
      cancel = cancellation.onCancellationRequested(() => job.state.cancel?.());
      report.report({message:this.message(job.state),increment:job.percentage});
      // A very short job may finish while VS Code creates the progress notification.
      if (!this.jobs.has(job.state.id)) { resolve(); }
      }).finally(() => cancel?.dispose());
    });
  }

  public updateStatus(): void {
    const job = [...this.jobs.values()].find(value=>!value.state.background) ?? [...this.jobs.values()][0];
    this.status.text = job
      ? '$(sync~spin) Shader: ' + (job.state.phase === 'discovering' ? '发现文件' : (job.state.phase === 'includes' ? 'include ' : '') + job.state.completed + '/' + job.state.total)
      : '$(symbol-namespace) Shader: ' + this.index.getDocumentCount() + (this.index.truncated ? '+' : '') + (this.index.paused ? ' · 已暂停' : '');
    this.status.tooltip = job ? this.message(job.state) + '\n点击展开进度' : 'Shader Navigator 已就绪。点击查看当前文件诊断。';
    const document = vscode.window.activeTextEditor?.document;
    if (document && /\.(shader|shaderlab|hlsl|hlsli|cginc|compute|inc)$/i.test(document.fileName)) { this.status.show(); } else { this.status.hide(); }
  }

  public dispose(): void {
    for (const job of this.jobs.values()) { if (job.timer) { clearTimeout(job.timer); } job.finish?.(); }
    this.jobs.clear();
    for (const subscription of this.subscriptions) { subscription.dispose(); }
  }
}
