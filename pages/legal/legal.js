const POLICY_VERSION = '2026-09-02'

Page({
  data: {
    accepted: false
  },

  onShow() {
    this.setData({
      accepted: wx.getStorageSync('campusPolicyAcceptedVersion') === POLICY_VERSION
    })
  },

  acceptPolicies() {
    wx.setStorageSync('campusPolicyAcceptedVersion', POLICY_VERSION)
    this.setData({ accepted: true })
    wx.showToast({ title: '已同意', icon: 'success' })
  }
})
