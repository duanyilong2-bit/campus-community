const MAX_AVATAR_SIZE = 1024 * 1024
const imageSecurity = require('../../utils/image-security')

function getFileExtension(filePath) {
  const match = String(filePath).match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
  const extension = match ? match[1].toLowerCase() : 'jpg'
  return ['jpg', 'jpeg', 'png', 'gif'].includes(extension) ? extension : 'jpg'
}

Page({
  data: {
    nickname: '',
    avatarUrl: '',
    avatarTempPath: '',
    isLoading: true,
    isSaving: false
  },

  onLoad() {
    this.loadUser()
  },

  async loadUser() {
    try {
      const response = await wx.cloud.callFunction({ name: 'getCurrentUser' })
      const result = response.result || {}
      if (!result.success || !result.user) {
        throw new Error(result.message || '读取资料失败')
      }
      getApp().globalData.currentUser = result.user
      this.setData({
        nickname: result.user.nickname || '校园社区用户',
        avatarUrl: result.user.avatarUrl || ''
      })
    } catch (error) {
      console.error('读取编辑资料页面失败：', error)
      wx.showToast({ title: '读取资料失败', icon: 'none' })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  onNicknameInput(event) {
    this.setData({ nickname: event.detail.value })
  },

  chooseAvatar() {
    if (this.data.isSaving) {
      return
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (result) => {
        const image = (result.tempFiles || [])[0]
        if (!image) {
          return
        }
        if (Number(image.size || 0) > MAX_AVATAR_SIZE) {
          wx.showToast({ title: '头像不能超过 1MB', icon: 'none' })
          return
        }
        this.setData({ avatarTempPath: image.tempFilePath })
      },
      fail: (error) => {
        if (!String(error.errMsg || '').includes('cancel')) {
          wx.showToast({ title: '选择头像失败', icon: 'none' })
        }
      }
    })
  },

  async uploadAvatar(userId) {
    const extension = getFileExtension(this.data.avatarTempPath)
    const result = await wx.cloud.uploadFile({
      cloudPath: `user-avatars/${userId}/avatar_${Date.now()}.${extension}`,
      filePath: this.data.avatarTempPath
    })
    if (!result.fileID) {
      throw new Error('头像上传失败')
    }
    return result.fileID
  },

  async saveProfile() {
    if (this.data.isSaving) {
      return
    }
    const nickname = this.data.nickname.trim()
    if (nickname.length < 2 || nickname.length > 16) {
      wx.showToast({ title: '昵称需要2到16个字', icon: 'none' })
      return
    }

    this.setData({ isSaving: true })
    let uploadedAvatarFileId = ''
    try {
      let user = getApp().globalData.currentUser
      if (!user) {
        await this.loadUser()
        user = getApp().globalData.currentUser
      }
      if (!user || !user.id) {
        throw new Error('用户身份未初始化')
      }

      const data = { nickname }
      if (this.data.avatarTempPath) {
        data.avatarFileId = await this.uploadAvatar(user.id)
        uploadedAvatarFileId = data.avatarFileId
        await imageSecurity.checkFiles([data.avatarFileId], 'AVATAR')
      }
      const response = await wx.cloud.callFunction({ name: 'updateProfile', data })
      const result = response.result || {}
      if (!result.success || !result.user) {
        if (data.avatarFileId) await imageSecurity.removeFiles([data.avatarFileId])
        wx.showToast({ title: result.message || '保存失败', icon: 'none' })
        return
      }

      getApp().globalData.currentUser = result.user
      wx.showToast({ title: '资料已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (error) {
      console.error('保存个人资料失败：', error)
      if (uploadedAvatarFileId) await imageSecurity.removeFiles([uploadedAvatarFileId])
      wx.showToast({ title: error.message || '头像上传或保存失败', icon: 'none' })
    } finally {
      this.setData({ isSaving: false })
    }
  }
})
