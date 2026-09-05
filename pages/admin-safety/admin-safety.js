Page({
  data: { verifications: [], disputes: [], feedback: [], suspendedUsers: [], processing: '' },
  onShow() { this.loadQueue() },
  onPullDownRefresh() { this.loadQueue().finally(() => wx.stopPullDownRefresh()) },

  async loadQueue() {
    try {
      const response = await wx.cloud.callFunction({ name: 'safetyApi', data: { action: 'getAdminQueue' } })
      const result = response.result || {}
      if (!result.success) throw new Error(result.message || '读取失败')
      this.setData({ verifications: result.verifications || [], disputes: result.disputes || [], feedback: result.feedback || [], suspendedUsers: result.suspendedUsers || [] })
    } catch (error) { wx.showToast({ title: error.message || '读取失败', icon: 'none' }) }
  },

  previewProof(event) { wx.previewImage({ current: event.currentTarget.dataset.url, urls: [event.currentTarget.dataset.url] }) },

  reviewVerification(event) {
    const id = event.currentTarget.dataset.id
    wx.showActionSheet({ itemList: ['通过认证', '拒绝认证'], success: (result) => this.callAction('reviewVerification', { id, approved: result.tapIndex === 0 }) })
  },

  resolveDispute(event) { this.askResult('resolveDispute', event.currentTarget.dataset.id, '填写争议处理结果') },
  resolveFeedback(event) { this.askResult('resolveFeedback', event.currentTarget.dataset.id, '填写反馈处理结果') },

  askResult(action, id, title) {
    wx.showModal({ title, editable: true, placeholderText: '请输入处理说明', success: (result) => { const content = String(result.content || '').trim(); if (result.confirm && content) this.callAction(action, { id, resultText: content }) } })
  },

  suspendUser(event) {
    const targetUserId = event.currentTarget.dataset.user
    wx.showModal({ title: '暂停账号', content: '暂停后该账号不能继续发布、接单或互动。', success: (result) => { if (result.confirm) this.callAction('setAccountStatus', { targetUserId, status: 'SUSPENDED' }) } })
  },

  restoreUser(event) { this.callAction('setAccountStatus', { targetUserId: event.currentTarget.dataset.user, status: 'ACTIVE' }) },

  async callAction(action, data) {
    if (this.data.processing) return
    this.setData({ processing: action })
    try {
      const response = await wx.cloud.callFunction({ name: 'safetyApi', data: { action, ...data } })
      const result = response.result || {}
      wx.showToast({ title: result.success ? '处理完成' : (result.message || '处理失败'), icon: result.success ? 'success' : 'none' })
    } catch (error) { wx.showToast({ title: '处理失败，请重试', icon: 'none' }) }
    finally { this.setData({ processing: '' }); await this.loadQueue() }
  }
})
