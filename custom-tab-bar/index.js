Component({
  data: {
    selected: 0,
    tabs: [
      { pagePath: '/pages/index/index', text: '首页', icon: '⌂' },
      { pagePath: '/pages/forum/forum', text: '校园圈', icon: '圈' },
      { pagePath: '/pages/publish/publish', text: '发布', icon: '+' },
      { pagePath: '/pages/tasks/tasks', text: '任务', icon: '跑' },
      { pagePath: '/pages/profile/profile', text: '我的', icon: '○' }
    ]
  },

  methods: {
    switchTab(event) {
      const index = Number(event.currentTarget.dataset.index)
      const pagePath = event.currentTarget.dataset.path

      if (!pagePath) {
        return
      }

      if (index === 2) {
        wx.showActionSheet({
          itemList: ['发布任务', '发布校园帖子'],
          success: (result) => {
            if (result.tapIndex === 0) {
              wx.switchTab({ url: '/pages/publish/publish' })
            } else if (result.tapIndex === 1) {
              wx.navigateTo({ url: '/pages/forum-publish/forum-publish' })
            }
          }
        })
        return
      }

      this.setData({ selected: index })
      wx.switchTab({ url: pagePath })
    }
  }
})
