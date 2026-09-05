// 请替换为你自己的 CloudBase 环境 ID。
const CLOUD_ENV_ID = 'your-cloudbase-env-id'

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请升级微信开发者工具或调试基础库')
      return
    }

    wx.cloud.init({
      env: CLOUD_ENV_ID,
      traceUser: true
    })

    this.initializeCloudUser()
  },

  async initializeCloudUser() {
    try {
      const response = await wx.cloud.callFunction({
        name: 'getCurrentUser'
      })
      const result = response.result || {}

      if (!result.success) {
        console.error('getCurrentUser 调用失败：', result.code, result.message)
        return
      }

      this.globalData.currentUser = result.user
      console.log('getCurrentUser 调用成功：', {
        created: result.created,
        user: result.user
      })
    } catch (error) {
      console.error('getCurrentUser 云函数调用异常：', error)
    }
  },

  globalData: {
    appName: '校园社区',
    cloudEnvId: CLOUD_ENV_ID,
    currentUser: null
  }
})
