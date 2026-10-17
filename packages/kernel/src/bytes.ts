/**
 * 跨边界字节计数。
 *
 * ## 为什么不用 `String.length`
 *
 * `String.length` 数的是 **UTF-16 码元**，不是字节。一个汉字在 UTF-8 里占 3 字节，
 * 但 `.length` 只算 1 —— 拿它当字节配额，中文内容的实际占用会被**低估到三分之一**，
 * 配额形同虚设。而 Matrix 的目标用户是中文场景的学生，这不是边角情况。
 *
 * ## 为什么沙箱内外必须同口径
 *
 * 宿主这边算 `boundaryBytes` 与 dataBus 配额，QuickJS 那边按 WASM 堆计入内存上限。
 * 两边口径不一致，就会出现「宿主认为还没超，沙箱已经 OOM」这类无法解释的失败。
 * 所以整个内核只允许有这一个字节计数实现。
 */

let encoder: TextEncoder | undefined;

/**
 * 字符串的 UTF-8 字节数。
 *
 * 快路径：纯 ASCII（URL、JSON 键名、英文响应体 —— 实际绝大多数调用）直接返回长度，
 * 不做任何分配。慢路径才走 `TextEncoder`。
 */
export function byteLen(s: string): number {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) {
      encoder ??= new TextEncoder();
      return encoder.encode(s).length;
    }
  }
  return s.length;
}

/** 一个值序列化成 JSON 后的 UTF-8 字节数。序列化失败（循环引用等）按 0 计。 */
export function jsonByteLen(value: unknown): number {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? 0 : byteLen(s);
  } catch {
    return 0;
  }
}
