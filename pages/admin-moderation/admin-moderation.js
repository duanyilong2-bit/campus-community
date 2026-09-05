Page({
  data: {
    reports: [],
    isLoading: false,
    processingId: ''
  },

  onShow() {
    this.loadReports()
  },

  onPullDownRefresh() {
    this.loadReports().finally(() => wx.stopPullDownRefresh())
  },

  async loadReports() {
    if (this.data.isLoading) return
    this.setData({ isLoading: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'adminApi',
        data: { action: 'listReports' }
      })
      const result = response.result || {}
      if (!result.success) throw new Error(result.message || '读取举报失败')
      this.setData({ reports: Array.isArray(result.reports) ? result.reports : [] })
    } catch (error) {
      console.error('读取举报记录失败：', error)
      wx.showToast({ title: error.message || '读取失败', icon: 'none' })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  chooseDecision(event) {
    const reportId = event.currentTarget.dataset.id
    wx.showActionSheet({
      itemList: ['删除违规帖子', '保留帖子并驳回举报'],
      success: (result) => this.resolveReport(reportId, result.tapIndex === 0 ? 'REMOVE' : 'DISMISS')
    })
  },

  async resolveReport(reportId, decision) {
    if (this.data.processingId) return
    this.setData({ processingId: reportId })
    try {
      const response = await wx.cloud.callFunction({
        name: 'adminApi',
        data: { action: 'resolveReport', reportId, decision }
      })
      const result = response.result || {}
      wx.showToast({ title: result.success ? '处理完成' : (result.message || '处理失败'), icon: result.success ? 'success' : 'none' })
    } catch (error) {
      console.error('处理举报失败：', error)
      wx.showToast({ title: '处理失败，请重试', icon: 'none' })
    } finally {
      this.setData({ processingId: '' })
      await this.loadReports()
    }
  }
})
