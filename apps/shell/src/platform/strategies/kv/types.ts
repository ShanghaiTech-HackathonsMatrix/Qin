/**
 * 键值存储抽象。
 *
 * 这是 S3（密钥存储）的可替换点：理想实现走 Android Keystore / iOS Keychain，
 * 实机若发现不可用，注册表会自动降到 Preferences，再降到 localStorage。
 * 业务代码只依赖这个接口，不关心底层。
 */
export interface SecureStore {
  /** 该实现是否提供真正的加密/系统级保护 */
  readonly encrypted: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 生成一个随机测试键，用于 probe 往返验证后清理 */
export function probeKey(): string {
  return `__probe_${Math.random().toString(36).slice(2)}_${Date.now()}`;
}
