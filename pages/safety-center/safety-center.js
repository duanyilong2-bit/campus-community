const subscriptionConfig = require('../../utils/subscription-config')
const imageSecurity = require('../../utils/image-security')

const VERIFICATION_TEXT = { UNVERIFIED: '未认证', PENDING: '审核中', VERIFIED: '已认证', REJECTED: '未通过' }

Page({
  data: {
    verificationStatus: 'UNVERIFIED',
    verificationText: '未认证',
    accountStatus: 'ACTIVE',
    subscriptionEnabled: false,
    studentNoLast4: '',
    proofTempPath: '',
    feedbackCategories: ['功能问题', '使用建议', '账号问题', '内容举报', '其他'],
    feedbackCategoryIndex: 0,
    feedbackContent: '',
    feedback: [],
    disputes: [],
    isSubmitting: false
  },

  onShow() { this.loadData() },
  onPullDownRefresh() { this.loadData().finally(() => wx.stopPullDownRefresh()) },

  async loadData() {
    try {
      const response = await wx.cloud.callFunction({ name: 'safetyApi', data: { action: 'getCenterData' } })
      const result = response.result || {}
      if (!result.success) throw new Error(result.message || '读取失败')
      this.setData({
        verificationStatus: result.verificationStatus || 'UNVERIFIED',
        verificationText: VERIFICATION_TEXT[result.verificationStatus] || '未知',
        accountStatus: result.accountStatus || 'ACTIVE',
        subscriptionEnabled: Boolean(result.subscriptionEnabled),
        feedback: result.feedback || [],
        disputes: result.disputes || []
      })
    } catch (error) {
      console.error('读取安全中心失败：', error)
      wx.showToast({ title: error.message || '读取失败', icon: 'none' })
    }
  },

  onStudentCodeInput(event) { this.setData({ studentNoLast4: event.detail.value }) },
  onFeedbackInput(event) { this.setData({ feedbackContent: event.detail.value }) },
  onFeedbackCategoryChange(event) { this.setData({ feedbackCategoryIndex: Number(event.detail.value) }) },

  async chooseProof() {
    try {
      const result = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album', 'camera'], sizeType: ['compressed'] })
      const file = (result.tempFiles || [])[0]
      if (!file || Number(file.size || 0) > 1024 * 1024) return wx.showToast({ title: '图片不能超过1MB', icon: 'none' })
      this.setData({ proofTempPath: file.tempFilePath })
    } catch (error) {}
  },

  async submitVerification() {
    if (this.data.isSubmitting) return
    if (!this.data.studentNoLast4 || !this.data.proofTempPath) return wx.showToast({ title: '请填写学号后几位并上传凭证', icon: 'none' })
    this.setData({ isSubmitting: true })
    let uploadedFileId = ''
    try {
      const user = getApp().globalData.currentUser
      if (!user || !user.id) throw new Error('用户身份尚未加载')
      const upload = await wx.cloud.uploadFile({ cloudPath: `verification-proofs/${user.id}/${Date.now()}.jpg`, filePath: this.data.proofTempPath })
      uploadedFileId = upload.fileID
      await imageSecurity.checkFiles([uploadedFileId], 'VERIFICATION')
      const response = await wx.cloud.callFunction({ name: 'safetyApi', data: { action: 'submitVerification', studentNoLast4: this.data.studentNoLast4, proofFileId: upload.fileID } })
      const result = response.result || {}
      wx.showToast({ title: result.success ? '认证已提交' : (result.message || '提交失败'), icon: result.success ? 'success' : 'none' })
      if (result.success) {
        this.setData({ proofTempPath: '', studentNoLast4: '' })
      } else {
        await imageSecurity.removeFiles([uploadedFileId])
        uploadedFileId = ''
      }
    } catch (error) {
      console.error('提交认证失败：', error)
      if (uploadedFileId) await imageSecurity.removeFiles([uploadedFileId])
      wx.showToast({ title: error.message || '提交失败', icon: 'none' })
    } finally { this.setData({ isSubmitting: false }); await this.loadData() }
  },

  async requestTaskSubscription() {
    if (subscriptionConfig.taskStatusTemplateIds.length === 0) {
      wx.showModal({ title: '订阅模板待配置', content: '站内互动消息可以正常使用。微信服务通知需要管理员在公众平台申请模板后才能开启。', showCancel: false })
      return false
    }
    try {
      const subscribeResult = await wx.requestSubscribeMessage({ tmplIds: subscriptionConfig.taskStatusTemplateIds })
      const accepted = subscriptionConfig.taskStatusTemplateIds.some((id) => subscribeResult[id] === 'accept')
      if (!accepted) {
        wx.showToast({ title: '你没有同意接收提醒', icon: 'none' })
        return false
      }
      const response = await wx.cloud.callFunction({ name: 'safetyApi', data: { action: 'setSubscription', enabled: true } })
      const result = response.result || {}
      if (!result.success) throw new Error(result.message || '设置失败')
      this.setData({ subscriptionEnabled: true })
      wx.showToast({ title: '已获得一次提醒授权', icon: 'success' })
      return true
    } catch (error) {
      const detail = String(error.errMsg || error.message || '未知错误')
      console.error('申请微信服务通知失败：', error)
      if (!detail.includes('cancel')) {
        wx.showModal({
          title: '提醒开启失败',
          content: detail.length > 160 ? `${detail.slice(0, 160)}…` : detail,
          showCancel: false
        })
      }
      return false
    }
  },

  async submitFeedback() {
    if (this.data.isSubmitting) return
    const content = this.data.feedbackContent.trim()
    if (content.length < 5) return wx.showToast({ title: '请至少填写5个字', icon: 'none' })
    this.setData({ isSubmitting: true })
    try {
      const response = await wx.cloud.callFunction({ name: 'safetyApi', data: { action: 'submitFeedback', category: this.data.feedbackCategories[this.data.feedbackCategoryIndex], content } })
      const result = response.result || {}
      wx.showToast({ title: result.success ? '反馈已提交' : (result.message || '提交失败'), icon: result.success ? 'success' : 'none' })
      if (result.success) this.setData({ feedbackContent: '' })
    } catch (error) { wx.showToast({ title: '提交失败，请重试', icon: 'none' }) }
    finally { this.setData({ isSubmitting: false }); await this.loadData() }
  },

  openContact() {},
  openLegal() { wx.navigateTo({ url: '/pages/legal/legal' }) }
})
