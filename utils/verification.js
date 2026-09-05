function isUnverified() {
  const app = getApp()
  const user = app && app.globalData ? app.globalData.currentUser : null
  return !user || user.campusVerificationStatus !== 'VERIFIED'
}

async function refresh() {
  const app = getApp()
  if (!app.globalData.currentUser) {
    try {
      const response = await wx.cloud.callFunction({ name: 'getCurrentUser' })
      const result = response.result || {}
      if (result.success && result.user) app.globalData.currentUser = result.user
    } catch (error) {
      console.error('读取校园认证状态失败：', error)
    }
  }
  return isUnverified()
}

function openSafetyCenter() {
  wx.navigateTo({ url: '/pages/safety-center/safety-center' })
}

module.exports = { isUnverified, refresh, openSafetyCenter }
