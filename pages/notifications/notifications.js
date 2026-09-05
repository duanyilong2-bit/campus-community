Page({
  data: {
    notifications: [],
    isLoading: false
  },

  onShow() {
    this.loadNotifications()
  },

  onPullDownRefresh() {
    this.loadNotifications().finally(() => wx.stopPullDownRefresh())
  },

  async loadNotifications() {
    if (this.data.isLoading) {
      return
    }
    this.setData({ isLoading: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'listNotifications' }
      })
      const result = response.result || {}
      if (!result.success) {
        throw new Error(result.message || '读取互动消息失败')
      }
      const notifications = (Array.isArray(result.notifications) ? result.notifications : [])
        .map((item) => ({
          ...item,
          avatarText: ['LIKE', 'COMMENT', 'COMMENT_LIKE', 'REPLY'].includes(item.type) ? String(item.actorName || '文').slice(0, 1) : '系',
          actionText: {
            LIKE: '赞了你的帖子',
            COMMENT: '评论了你的帖子',
            COMMENT_LIKE: '赞了你的评论',
            REPLY: '回复了你的评论',
            TASK_ACCEPTED: '你的任务已被接单',
            TASK_SUBMITTED: '接单者提交了完成凭证',
            TASK_COMPLETED: '发布者已确认任务完成',
            VERIFICATION_RESULT: '校园认证审核有新结果',
            FEEDBACK_RESULT: '你的反馈已处理',
            DISPUTE_RESULT: '订单争议已有处理结果',
            ACCOUNT_STATUS: '账号状态发生变化'
          }[item.type] || '有一条新消息',
          isForumNotice: ['LIKE', 'COMMENT', 'COMMENT_LIKE', 'REPLY'].includes(item.type),
          isTaskNotice: ['TASK_ACCEPTED', 'TASK_SUBMITTED', 'TASK_COMPLETED'].includes(item.type)
        }))
      this.setData({ notifications })
      if (Number(result.unreadCount || 0) > 0) {
        await wx.cloud.callFunction({
          name: 'forumApi',
          data: { action: 'markNotificationsRead' }
        })
      }
    } catch (error) {
      console.error('读取互动消息失败：', error)
      wx.showToast({ title: '读取消息失败', icon: 'none' })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  openNotification(event) {
    const item = this.data.notifications[Number(event.currentTarget.dataset.index)]
    if (!item) return
    if (item.isForumNotice && item.postId) {
      wx.navigateTo({ url: `/pages/forum-detail/forum-detail?id=${encodeURIComponent(item.postId)}` })
      return
    }
    if (item.type === 'TASK_COMPLETED') {
      wx.navigateTo({ url: '/pages/orders/orders' })
      return
    }
    if (item.isTaskNotice && item.taskId) {
      wx.navigateTo({ url: `/pages/task-detail/task-detail?id=${encodeURIComponent(item.taskId)}&source=cloud` })
      return
    }
    wx.navigateTo({ url: '/pages/safety-center/safety-center' })
  },

  openForum() {
    wx.switchTab({ url: '/pages/forum/forum' })
  }
})
