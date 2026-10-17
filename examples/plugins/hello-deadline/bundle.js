// 纯函数入口；没有 import / require、DOM、网络或异步调用。
globalThis.plugin = {
  parsers: {},
  plan(input) {
    return {
      requests: [],
      entities: [{type: 'notice', id: 'welcome', data: {title: '插件同步示例', at: input.now + 3600000}}],
      summary: '已生成一条合成事项'
    };
  },
  renders: {
    summary(ctx) {
      return {type: 'card', children: [{type: 'text', text: '插件已在独立沙箱运行'}, {type: 'text', text: '本示例不联网；再次同步会更新同一条事项。'}, {type: 'button', label: '查看专属页面', onPress: {kind: 'navigate', to: 'details'}}]};
    },
    details(ctx) {
      return {type: 'card', children: [{type: 'text', text: '这是插件的独立页面，仍由宿主渲染 UiNode。'}, {type: 'button', label: '重新生成示例事项', onPress: {kind: 'sync'}}, {type: 'button', label: '返回首页', onPress: {kind: 'navigate', to: 'home'}}]};
    }
  }
};
