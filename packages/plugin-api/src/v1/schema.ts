/**
 * 实体 Schema —— manifest 与数据总线**共用**的那一份定义。
 *
 * ## 为什么它属于契约包
 *
 * `EntitySchema` 出现在 manifest 的 `contributes.entityTypes` 里 —— 它是**插件契约的一部分**，
 * 不是内核的内部结构。原来它定义在 `packages/kernel/src/databus.ts`，后果有三个：
 *
 *   1. manifest 校验只能把 `entityTypes` 当 `unknown[]`，形状错了查不出来；
 *   2. `registry.ts` 得写一句 `decl.schema as EntitySchema` 的强制转换；
 *   3. 「manifest 说通过、install 说不行」这种不一致没有任何东西拦得住。
 *
 * 现在权威定义在这里，内核 `import` 它。方向也是对的：内核本来就依赖契约包。
 *
 * ## 这不是 JSON Schema
 *
 * 是一个**很小的子集**：对象 + 具名字段 + 六种标量类型 + 数组 + `enum` + `required`。
 * 刻意不实现 `$ref` / `oneOf` / `pattern` / `format` —— 每多一个特性，
 * 沙箱两侧就要多一份必须保持一致的实现。
 */

/** 字段类型。`integer` 与 `number` 的区别是前者要求 `Number.isInteger`。 */
export const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSchema {
  /** 不写则只做 `enum` / `null` 检查，不做类型检查 */
  type?: FieldType;
  enum?: unknown[];
  /** 字符串长度上限。数的是 **UTF-16 码元**（`value.length`），不是字节也不是码点 */
  maxLength?: number;
  /** 数组元素 */
  items?: FieldSchema;
  /** 允许 null。默认 false */
  nullable?: boolean;
  /**
   * 是否允许**其它插件**读到这个字段。
   * 默认 true。设 false 表示「本插件内部用」，跨插件读取时会被裁掉。
   */
  shared?: boolean;
}

export interface EntitySchema {
  type: 'object';
  properties?: Record<string, FieldSchema>;
  required?: string[];
  /** 默认 false：多出来的字段一律拒绝（宁可让作者补 schema） */
  additionalProperties?: boolean;
}

export interface SchemaIssue {
  path: string;
  message: string;
}

/**
 * 实体类型名的约束。
 *
 * **单一来源**：manifest 的 `contributes.entityTypes` 校验、
 * `permissions.data.write/read` 校验、`DataBus.declareSchema` 三处都用这一个。
 * 名字会成为记录键与表名的一部分，必须是安全标识符 ——
 * 三处各写一份正则的话，漂移的那一份就是一条注入缝隙。
 */
export const ENTITY_TYPE_RE = /^[a-z][a-z0-9_]*$/;
