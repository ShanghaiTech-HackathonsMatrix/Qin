/**
 * 日期键：`YYYY-MM-DD`，本地时区。
 *
 * 为什么单独一个文件：这个函数同时被**视图**（`views/ScheduleView.tsx`）和
 * **纯逻辑**（`app/ddl-items.ts`）用到，而纯逻辑那侧要能在 Node 里直接跑测试。
 * Node 的类型剥离不处理 `.tsx`，所以纯逻辑不能从 `.tsx` 里 import ——
 * 把它下沉到这里，两边都不必为了对方让步。
 */

const PAD = (n: number) => String(n).padStart(2, '0');

export function dayKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}