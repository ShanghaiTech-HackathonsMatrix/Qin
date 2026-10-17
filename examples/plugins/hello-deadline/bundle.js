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
      return {type: 'card', children: [{type: 'text', text: '插件已在独立沙箱运行'}, {type: 'text', text: '本示例不联网；再次同步会更新同一条事项。'}]};
    }
  }
};
