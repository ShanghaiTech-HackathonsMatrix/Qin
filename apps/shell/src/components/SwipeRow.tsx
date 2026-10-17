/**
 * 左滑露出操作按钮的容器。
 *
 * 为什么不用现成的库：这一版对交互只有两个硬要求 ——
 * 触屏上能用、纵向滚动不能被打断。自己写三十行比引一个库更可控，
 * 也免得把「手势库」变成新的依赖负担。
 *
 * 判定规则：
 *   · 横向位移超过 10px 且大于纵向位移，才认定为「在滑动」；
 *   · 否则直接放弃这次手势，让页面正常纵向滚动 ——
 *     手机上最常见的挫败感就是「想滚列表，结果把卡片划开了」。
 *
 * 无障碍：按钮始终在 DOM 里，Tab 能聚焦到，滑不开也能用键盘操作。
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

export interface SwipeAction {
  label: string;
  onClick: () => void;
  /** 危险操作（删除）用反色实心 */
  danger?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: readonly SwipeAction[];
  children: ReactNode;
  /** 单颗按钮宽度，用来算滑出距离 */
  actionWidth?: number;
}

export default function SwipeRow({ open, onOpenChange, actions, children, actionWidth = 66 }: Props) {
  const max = actions.length * actionWidth;
  const [dragX, setDragX] = useState<number | null>(null);
  const gesture = useRef<{ x: number; y: number; base: number; active: boolean; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const reset = useCallback(() => {
    gesture.current = null;
    setDragX(null);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (max === 0) return;
    gesture.current = { x: event.clientX, y: event.clientY, base: open ? -max : 0, active: false, moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (g === null) return;
    const dx = event.clientX - g.x;
    const dy = event.clientY - g.y;

    if (!g.active) {
      if (Math.abs(dx) < 10) return;
      // 纵向意图更强 → 交还给页面滚动，这次手势不再管
      if (Math.abs(dx) <= Math.abs(dy)) {
        gesture.current = null;
        return;
      }
      g.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    g.moved = true;
    setDragX(Math.max(-max, Math.min(0, g.base + dx)));
  };

  const onPointerUp = () => {
    const g = gesture.current;
    if (g === null) return;
    const current = dragX ?? g.base;
    gesture.current = null;
    setDragX(null);

    if (!g.active) return;
    // 滑动之后紧接着的那次 click 是误触，吞掉它
    if (g.moved) suppressClick.current = true;
    onOpenChange(current < -max / 2);
  };

  const onClickCapture = (event: React.MouseEvent) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  const offset = dragX ?? (open ? -max : 0);

  return (
    <div className="swipe" data-open={open} data-dragging={dragX !== null}>
      {max > 0 && (
        <div className="swipe__actions" style={{ width: max }}>
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="swipe__action"
              data-danger={action.danger === true}
              onClick={() => {
                onOpenChange(false);
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <div
        className="swipe__surface"
        style={offset === 0 ? undefined : { transform: `translateX(${offset}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={reset}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>
    </div>
  );
}