Page({
  data: {
    nickname: '校园社区用户',
    avatarUrl: '',
    identityText: '正在同步云端身份',
    schoolName: '校园社区',
    stats: {
      published: 0,
      accepted: 0,
      completed: 0
    },
    isLoadingStats: false,
    unreadCount: 0,
    isAdmin: false,
    campusVerified: false
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) {
      tabBar.setData({ selected: 4 })
    }

    this.loadProfile()
    this.loadStats()
    this.loadUnreadCount()
  },

  async loadProfile() {
    const app = getApp()
    const cachedUser = app.globalData.currentUser
    if (cachedUser) {
      this.setData({
        nickname: cachedUser.nickname || '校园社区用户',
        avatarUrl: cachedUser.avatarUrl || '',
        identityText: 'CloudBase 身份已连接',
        isAdmin: cachedUser.role === 'ADMIN',
        campusVerified: cachedUser.campusVerificationStatus === 'VERIFIED'
      })
    }

    try {
      const response = await wx.cloud.callFunction({ name: 'getCurrentUser' })
      const result = response.result || {}
      if (!result.success || !result.user) {
        return
      }
      app.globalData.currentUser = result.user
      this.setData({
        nickname: result.user.nickname || '校园社区用户',
        avatarUrl: result.user.avatarUrl || '',
        identityText: 'CloudBase 身份已连接',
        isAdmin: result.user.role === 'ADMIN',
        campusVerified: result.user.campusVerificationStatus === 'VERIFIED'
      })
    } catch (error) {
      console.error('刷新个人资料失败：', error)
    }
  },

  async loadStats() {
    if (this.data.isLoadingStats) {
      return
    }

    this.setData({ isLoadingStats: true })
    try {
      const responses = await Promise.all([
        wx.cloud.callFunction({ name: 'getMyTaskData', data: { type: 'published' } }),
        wx.cloud.callFunction({ name: 'getMyTaskData', data: { type: 'orders' } })
      ])
      const publishedResult = responses[0].result || {}
      const ordersResult = responses[1].result || {}
      const published = publishedResult.success && Array.isArray(publishedResult.items)
        ? publishedResult.items
        : []
      const orders = ordersResult.success && Array.isArray(ordersResult.items)
        ? ordersResult.items
        : []

      this.setData({
        stats: {
          published: published.length,
          accepted: orders.length,
          completed: orders.filter((order) => order.status === 'COMPLETED').length
        }
      })
    } catch (error) {
      console.error('读取个人中心统计失败：', error)
    } finally {
      this.setData({ isLoadingStats: false })
    }
  },

  openMyPublished() {
    wx.navigateTo({ url: '/pages/my-published/my-published' })
  },

  openMyOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' })
  },

  openPublish() {
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  openTasks() {
    wx.switchTab({ url: '/pages/tasks/tasks' })
  },

  openEditProfile() {
    wx.navigateTo({ url: '/pages/profile-edit/profile-edit' })
  },

  openMyPosts() {
    wx.navigateTo({ url: '/pages/my-posts/my-posts' })
  },

  openNotifications() {
    wx.navigateTo({ url: '/pages/notifications/notifications' })
  },

  openLegal() {
    wx.navigateTo({ url: '/pages/legal/legal' })
  },

  openAdminModeration() {
    wx.navigateTo({ url: '/pages/admin-moderation/admin-moderation' })
  },

  openSafetyCenter() {
    wx.navigateTo({ url: '/pages/safety-center/safety-center' })
  },

  openAdminSafety() {
    wx.navigateTo({ url: '/pages/admin-safety/admin-safety' })
  },

  async loadUnreadCount() {
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'getNotificationSummary' }
      })
      const result = response.result || {}
      if (result.success) {
        this.setData({ unreadCount: Number(result.unreadCount || 0) })
      }
    } catch (error) {
      console.error('读取个人中心未读消息失败：', error)
    }
  },

  showCloudIdentity() {
    wx.showModal({
      title: '云端身份',
      content: '当前已通过微信 OPENID 识别用户。为保护隐私，页面不会显示完整 OPENID。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  showProofInfo() {
    wx.navigateTo({ url: '/pages/orders/orders' })
  },

  showGuide() {
    wx.navigateTo({ url: '/pages/help-center/help-center' })
  },

  showAbout() {
    wx.showModal({
      title: '关于校园社区',
      content: '校园社区是面向校园生活、互动交流与同学互助的小程序，目前处于 CloudBase 测试阶段。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
