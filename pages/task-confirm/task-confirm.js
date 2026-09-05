const cloudFile = require('../../utils/cloud-file')

Page({
  data: {
    task: null,
    isLoading: true,
    isConfirming: false
  },

  onLoad(options) {
    this.taskId = String(options.taskId || '')
    if (!this.taskId) {
      this.setData({ isLoading: false })
      wx.showToast({ title: '任务信息无效', icon: 'none' })
      return
    }
    this.loadTask()
  },

  async loadTask() {
    try {
      const response = await wx.cloud.callFunction({
        name: 'getMyTaskData',
        data: { type: 'published', page: 1, pageSize: 50 }
      })
      const result = response.result || {}
      if (!result.success) throw new Error(result.message || '读取任务失败')
      const items = await cloudFile.resolveProofImages(Array.isArray(result.items) ? result.items : [])
      const task = items.find((item) => item.id === this.taskId)
      if (!task) throw new Error('没有找到待确认任务')
      this.setData({ task, isLoading: false })
    } catch (error) {
      console.error('读取任务确认信息失败：', error)
      this.setData({ isLoading: false })
      wx.showToast({ title: error.message || '读取失败，请稍后重试', icon: 'none' })
    }
  },

  previewProofImage(event) {
    wx.previewImage({
      current: event.currentTarget.dataset.current,
      urls: event.currentTarget.dataset.urls || []
    })
  },

  confirmTask() {
    if (this.data.isConfirming || !this.data.task) return
    wx.showModal({
      title: '确认完成',
      content: '确认接单者已完成这项任务吗？',
      confirmText: '确认完成',
      success: (modalResult) => {
        if (modalResult.confirm) this.submitConfirm()
      }
    })
  },

  async submitConfirm() {
    this.setData({ isConfirming: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'confirmTask',
        data: { taskId: this.taskId }
      })
      const result = response.result || {}
      if (!result.success) {
        wx.showToast({ title: result.message || '确认失败，请重试', icon: 'none' })
        return
      }
      wx.showToast({ title: '任务已完成', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (error) {
      console.error('confirmTask 调用失败：', error)
      wx.showToast({ title: '确认失败，请稍后重试', icon: 'none' })
    } finally {
      this.setData({ isConfirming: false })
    }
  }
})
