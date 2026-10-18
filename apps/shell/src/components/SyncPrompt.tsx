/**
 * 「还没连平台」时用的提示块。
 *
 * 之前首页的 DDL 卡、任务日志、日程、课表在没同步时各自留一句灰字，
 * 用户看完不知道该点哪 —— 登录入口在「设置 → 用户与账号」里，要穿三层。
 * 这里统一成一块：手绘虚线框 + 一枚同步图标 + 一句实话 + 一个黑色胶囊按钮，
 * 按钮直接把用户送到平台连接那一屏。
 *
 * 美工上和空态家族保持一致：虚线 1.5px、四角半径各不相同（和全站卡片同源）、
 * 图标用底栏那套 24 网格纯描边画法，不上色块。
 */

interface Props {
  /** 一句话说清现在为什么是空的 */
  title: string;
  /** 补一句怎么解决 */
  hint: string;
  onOpen: () => void;
  /** 按钮文案，默认「去平台连接」 */
  action?: string;
}

export default function SyncPrompt({ title, hint, onOpen, action = '去平台连接' }: Props) {
  return (
    <div className="sync-prompt">
      <span className="sync-prompt__mark" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {/* 一圈循环箭头：就是「同步」本身 */}
          <path d="M20 12a8 8 0 1 1-2.6-5.9" />
          <path d="M20 4.6V9.2h-4.6" />
        </svg>
      </span>

      <div className="sync-prompt__text">
        <strong>{title}</strong>
        <small>{hint}</small>
      </div>

      <button type="button" className="go-pill" onClick={onOpen}>
        {action}
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}
