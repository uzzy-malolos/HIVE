import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ApprovalPosture, KernelCheckpoint, KernelMessage, KernelSession, SurfaceMode } from "./types.js";

export class KernelSessionStore {
  private baseDir: string;

  constructor(storageDir: string) {
    this.baseDir = path.join(storageDir, "sessions");
  }

  public async init(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true });
  }

  private getSessionPath(id: string): string {
    return path.join(this.baseDir, `${id}.json`);
  }

  public async createSession(input: {
    surface: SurfaceMode;
    title?: string;
    workspaceRoot?: string;
    groundedPath?: string;
    posture?: ApprovalPosture;
    providerId?: string;
    model?: string;
  }): Promise<KernelSession> {
    const id = `ses_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
    const session: KernelSession = {
      id,
      surface: input.surface,
      title: input.title || (input.surface === "chat" ? "New Chat" : "New Task"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      workspaceRoot: input.workspaceRoot,
      groundedPath: input.groundedPath,
      posture: input.posture || (input.surface === "codex" ? "ask" : "auto"),
      providerId: input.providerId,
      model: input.model,
      archived: false,
      messages: [],
      checkpoints: [],
    };

    await this.saveSession(session);
    return session;
  }

  public async loadSession(id: string): Promise<KernelSession | null> {
    try {
      const raw = await fs.readFile(this.getSessionPath(id), "utf-8");
      return JSON.parse(raw) as KernelSession;
    } catch {
      return null;
    }
  }

  public async listSessions(surface?: SurfaceMode): Promise<KernelSession[]> {
    await fs.mkdir(this.baseDir, { recursive: true });
    const files = await fs.readdir(this.baseDir);
    const sessions: KernelSession[] = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(this.baseDir, file), "utf-8");
        const session = JSON.parse(raw) as KernelSession;
        if (!surface || session.surface === surface) {
          sessions.push(session);
        }
      } catch {
        // Ignore corrupted file
      }
    }

    sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return sessions;
  }

  public async saveSession(session: KernelSession): Promise<void> {
    const filePath = this.getSessionPath(session.id);
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    const payload = JSON.stringify(session, null, 2);

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tempPath, payload, "utf-8");
    await fs.rename(tempPath, filePath);
  }

  public async appendMessage(sessionId: string, message: KernelMessage): Promise<KernelSession> {
    const session = await this.loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);

    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
    if (session.messages.length === 1 && message.role === "user" && session.title.startsWith("New ")) {
      session.title = message.content.slice(0, 50).trim() || session.title;
    }

    await this.saveSession(session);
    return session;
  }

  public async recordCheckpoint(sessionId: string, checkpoint: KernelCheckpoint): Promise<KernelSession> {
    const session = await this.loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);

    session.checkpoints.push(checkpoint);
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);
    return session;
  }

  public async archiveSession(sessionId: string): Promise<KernelSession> {
    const session = await this.loadSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found.`);

    session.archived = true;
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);
    return session;
  }
}
