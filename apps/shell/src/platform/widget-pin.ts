export interface WidgetPinState {
  supported: boolean;
  widgetCount: number;
  status: 'idle' | 'requested' | 'confirmed' | 'unconfirmed';
}

export function widgetPinMessage(state: WidgetPinState): string {
  switch (state.status) {
    case 'requested': return '已请求添加，等待桌面确认。若没有弹窗，可按下方说明手动添加。';
    case 'confirmed': return state.widgetCount > 0
      ? '已确认添加，返回桌面即可查看挂件。'
      : '上次添加已获确认，当前未检测到挂件，可重新添加。';
    case 'unconfirmed': return '尚未确认添加。桌面可能未显示弹窗，或你尚未确认；可以重试，也可以手动添加。';
    default: return state.supported
      ? '可向当前桌面请求添加；是否显示确认窗口由桌面决定。'
      : '当前系统或桌面不支持一键添加，请按下方说明手动添加。';
  }
}

/** 仅限制界面等待，不伪造取消原生请求；迟到的结果仍由状态查询核对。 */
export async function requestWidgetPin(bridge: { pinWidget(): Promise<WidgetPinState> }, timeoutMs = 8000): Promise<WidgetPinState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      bridge.pinWidget(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('暂未收到桌面响应，请按下方说明手动添加；此页会继续检测添加结果。')), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
