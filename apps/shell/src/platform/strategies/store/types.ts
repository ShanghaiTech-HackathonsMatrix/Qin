import type { Course, Task } from '../../../domain/types';
import type { IndexingStrategy } from '../indexing/types';
import type { SecureStore } from '../kv/types';

/**
 * 业务数据持久化抽象。
 * 所有视图只依赖这个接口，因此底层从 SQLCipher 换成 JSON 文档库时，
 * 业务代码一行都不用改。
 */
export interface TaskStore {
  readonly backend: string;
  init(): Promise<void>;
  listTasks(): Promise<Task[]>;
  putTask(t: Task): Promise<void>;
  deleteTask(id: string): Promise<void>;
  listCourses(): Promise<Course[]>;
  putCourse(c: Course): Promise<void>;
  deleteCourse(id: string): Promise<void>;
  clearAll(): Promise<void>;
  stats(): Promise<{ tasks: number; courses: number }>;
  info(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

export interface StoreDeps {
  /** 索引策略；JSON 存储不需要，故可为 null */
  indexing: IndexingStrategy | null;
  kv: SecureStore | null;
}

const PASSPHRASE_KEY = 'db.passphrase';

/**
 * 取（或首次生成）数据库口令，存放在 KV 策略里。
 *
 * ⚠️ 诚实说明：如果 KV 降级到了明文实现（Preferences / localStorage），
 * 那么这个口令和数据库放在同一台设备上、且未受系统级保护，
 * 加密的实际收益就只剩「防随手翻文件」。这个组合会在自检报告里被标记出来。
 */
export async function getOrCreateDbPassphrase(kv: SecureStore): Promise<string> {
  const existing = await kv.get(PASSPHRASE_KEY);
  if (existing && existing.length >= 32) return existing;

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await kv.set(PASSPHRASE_KEY, hex);
  return hex;
}

export async function clearDbPassphrase(kv: SecureStore): Promise<void> {
  await kv.remove(PASSPHRASE_KEY);
}

/** 口令是否被安全保护 —— 用于自检报告里的真实强度评估 */
export function keyProtectionLevel(kv: SecureStore | null): 'system' | 'plaintext' | 'none' {
  if (!kv) return 'none';
  return kv.encrypted ? 'system' : 'plaintext';
}
