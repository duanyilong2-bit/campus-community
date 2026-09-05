Page({
  openPublish() {
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  openTasks() {
    wx.switchTab({ url: '/pages/tasks/tasks' })
  },

  openForum() {
    wx.switchTab({ url: '/pages/forum/forum' })
  },

  openOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' })
  },

  openPublished() {
    wx.navigateTo({ url: '/pages/my-published/my-published' })
  },

  openLegal() {
    wx.navigateTo({ url: '/pages/legal/legal' })
  }
})
