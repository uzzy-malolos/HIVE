import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { TaskRecord } from './types.js';
import { validateTaskId } from './worktree.js';

const execFileAsync = promisify(execFile);
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,160}$/;

export class TaskStore {
  private repoPath: string;
  private baseDir: string;

  constructor(repoPath: string) {
    this.repoPath = path.resolve(repoPath);
    this.baseDir = path.join(this.repoPath, '.hivemind', 'coder');
  }

  private async ensureDir(): Promise<void> {
    try {
      await fs.access(this.baseDir);
    } catch {
      await fs.mkdir(this.baseDir, { recursive: true });
    }
  }

  public async save(record: TaskRecord): Promise<void> {
    await this.ensureDir();
    const filePath = path.join(this.baseDir, `${record.taskId}.json`);
    const tmpPath = path.join(this.baseDir, `${record.taskId}.tmp.json`);
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }

  public async load(taskId: string): Promise<TaskRecord | null> {
    try {
      const filePath = path.join(this.baseDir, `${taskId}.json`);
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as TaskRecord;
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  public async list(): Promise<TaskRecord[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.baseDir);
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    
    const records: TaskRecord[] = [];
    for (const file of jsonFiles) {
      try {
        const data = await fs.readFile(path.join(this.baseDir, file), 'utf-8');
        records.push(JSON.parse(data) as TaskRecord);
      } catch (err) {
        // Skip invalid JSON files
        console.error(`Failed to read task record from ${file}:`, err);
      }
    }
    return records;
  }

  public async archive(taskId: string): Promise<TaskRecord> {
    const record = await this.requireTask(taskId);
    if (record.archived) return record;
    record.archived = true;
    record.archivedAt = new Date().toISOString();
    await this.save(record);
    return record;
  }

  public async unarchive(taskId: string): Promise<TaskRecord> {
    const record = await this.requireTask(taskId);
    if (!record.archived) return record;
    record.archived = false;
    delete record.archivedAt;
    await this.save(record);
    return record;
  }

  public async fork(taskId: string): Promise<TaskRecord> {
    const source = await this.requireTask(taskId);
    if (source.taskId !== taskId) {
      throw new Error(`Cannot fork task cell ${taskId}: record id does not match its file.`);
    }
    await this.assertForkable(source);
    const newId = await this.allocateTaskId();
    const copy: TaskRecord = structuredClone(source);
    copy.taskId = newId;
    copy.branchName = `hive-coder/${newId}`;
    copy.archived = false;
    copy.forkedFrom = source.taskId;
    delete copy.archivedAt;
    await this.save(copy);
    try {
      await this.copyDiffPatch(source.taskId, newId);
    } catch (error) {
      await this.rollbackFork(newId);
      throw error;
    }
    return (await this.load(newId)) ?? copy;
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    validateTaskId(taskId);
    const record = await this.load(taskId);
    if (!record) throw new Error(`Session ${taskId} not found.`);
    return record;
  }

  private async allocateTaskId(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = `cli-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
      validateTaskId(id);
      if (!(await this.load(id))) return id;
    }
    throw new Error('Could not allocate a task cell id.');
  }

  private diffPatchPath(taskId: string): string {
    return path.join(this.repoPath, '.hivemind', 'coder-tasks', taskId, 'diff.patch');
  }

  private async assertForkable(record: TaskRecord): Promise<void> {
    const worktreePath = path.join(this.repoPath, '.hivemind', 'worktrees', record.taskId);
    const worktreeStat = await fs.lstat(worktreePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (worktreeStat) {
      throw new Error(`Cannot fork task cell ${record.taskId}: git worktree ${worktreePath} is still present.`);
    }

    const taskDir = path.join(this.repoPath, '.hivemind', 'coder-tasks', record.taskId);
    const entries = await fs.readdir(taskDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entries) {
      const unexpected = entries.filter((name) => name !== 'diff.patch');
      if (unexpected.length > 0) {
        throw new Error(`Cannot fork task cell ${record.taskId}: task directory contains files that cannot be copied safely (${unexpected.join(', ')}).`);
      }
    }

    const patchPath = this.diffPatchPath(record.taskId);
    const patchStat = await fs.lstat(patchPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (record.diffSummary && !patchStat) {
      throw new Error(`Cannot fork task cell ${record.taskId}: diff.patch is missing.`);
    }
    if (patchStat && (patchStat.isSymbolicLink() || !patchStat.isFile())) {
      throw new Error(`Cannot fork task cell ${record.taskId}: diff.patch is not a regular file.`);
    }

    const branchName = record.branchName?.trim();
    if (!branchName) return;
    if (!(await this.gitBranchExists(record.taskId, branchName))) return;
    throw new Error(`Cannot fork task cell ${record.taskId}: git branch ${branchName} still exists.`);
  }

  private async gitBranchExists(taskId: string, branchName: string): Promise<boolean> {
    if (!SAFE_BRANCH.test(branchName) || branchName.includes('..') || branchName.endsWith('/') || branchName.endsWith('.')) {
      throw new Error(`Cannot fork task cell ${taskId}: branch name cannot be verified safely.`);
    }
    const gitMarker = await fs.lstat(path.join(this.repoPath, '.git')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!gitMarker) return false;

    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
        cwd: this.repoPath,
        windowsHide: true,
        timeout: 10_000,
      });
      return true;
    } catch (error) {
      const err = error as { code?: string | number; status?: number };
      if (err.code === 'ENOENT') {
        throw new Error(`Cannot fork task cell ${taskId}: git is required to verify branch ${branchName}.`);
      }
      const exitCode = err.status ?? (typeof err.code === 'number' ? err.code : Number(err.code));
      if (exitCode === 1) return false;
      throw new Error(`Cannot fork task cell ${taskId}: unable to verify git branch ${branchName}.`);
    }
  }

  private async copyDiffPatch(sourceId: string, destId: string): Promise<void> {
    const source = this.diffPatchPath(sourceId);
    const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return;
    const destination = this.diffPatchPath(destId);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }

  private async rollbackFork(taskId: string): Promise<void> {
    await fs.rm(path.join(this.baseDir, `${taskId}.json`), { force: true });
    await fs.rm(path.join(this.repoPath, '.hivemind', 'coder-tasks', taskId), { recursive: true, force: true });
  }
}
