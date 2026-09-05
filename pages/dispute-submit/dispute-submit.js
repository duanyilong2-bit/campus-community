Page({
  data: {
    reasons: ['无法联系对方', '任务描述不一致', '完成结果有争议', '疑似违规任务', '其他'],
    reasonIndex: 0,
    description: '',
    isSubmitting: false
  },

  onLoad(options) { this.orderId = decodeURIComponent(options.orderId || '') },
  onReasonChange(event) { this.setData({ reasonIndex: Number(event.detail.value) }) },
  onDescriptionInput(event) { this.setData({ description: event.detail.value }) },

  async submitDispute() {
    if (this.data.isSubmitting) return
    if (!this.orderId) return wx.showToast({ title: '订单信息无效', icon: 'none' })
    const description = this.data.description.trim()
    if (description.length < 5) return wx.showToast({ title: '请至少填写5个字', icon: 'none' })
    this.setData({ isSubmitting: true })
    try {
      const response = await wx.cloud.callFunction({ name: 'safetyApi', data: { action: 'createDispute', orderId: this.orderId, reason: this.data.reasons[this.data.reasonIndex], description } })
      const result = response.result || {}
      if (!result.success) return wx.showToast({ title: result.message || '提交失败', icon: 'none' })
      wx.showToast({ title: '已提交处理', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (error) { wx.showToast({ title: '提交失败，请重试', icon: 'none' }) }
    finally { this.setData({ isSubmitting: false }) }
  }
})
