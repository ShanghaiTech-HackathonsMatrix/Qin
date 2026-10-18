import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { requestWidgetPin, widgetPinMessage, type WidgetPinState } from './widget-pin.ts';

const pending: WidgetPinState = { supported: true, widgetCount: 1, status: 'requested' };
test('桌面接受请求且已有挂件时仍显示等待，而不是本次已添加', async () => {
  const result = await requestWidgetPin({ pinWidget: async () => pending });
  assert.match(widgetPinMessage(result), /等待桌面确认/);
  assert.doesNotMatch(widgetPinMessage(result), /已确认添加/);
});
test('没有回调只标记尚未确认，并一直提供手动添加说明', () => {
  assert.match(widgetPinMessage({ ...pending, status: 'unconfirmed' }), /尚未确认添加/);
  assert.match(widgetPinMessage({ ...pending, supported: false, status: 'idle' }), /不支持一键添加/);
  assert.match(widgetPinMessage({ ...pending, status: 'unconfirmed' }), /手动添加/);
});
test('成功确认后挂件被删除时不再指引用户去桌面查看不存在的挂件', () => {
  assert.match(widgetPinMessage({ ...pending, status: 'confirmed' }), /已确认添加/);
  assert.match(widgetPinMessage({ ...pending, status: 'confirmed', widgetCount: 0 }), /当前未检测到挂件/);
});
test('没有响应的原生调用会解除界面等待，迟到成功不会变成未处理异常', async () => {
  let resolve!: (state: WidgetPinState) => void;
  const delayed = new Promise<WidgetPinState>(done => { resolve = done; });
  await assert.rejects(requestWidgetPin({ pinWidget: () => delayed }, 10), /暂未收到桌面响应/);
  resolve({ ...pending, status: 'confirmed' });
  await delayed;
});
test('原生错误原样返回给界面', async () => {
  await assert.rejects(requestWidgetPin({ pinWidget: async () => { throw new Error('桌面拒绝'); } }), /桌面拒绝/);
});
