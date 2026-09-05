const MAX_IMAGES = 3
const MAX_IMAGE_SIZE = 1024 * 1024
const verification = require('../../utils/verification')
const imageSecurity = require('../../utils/image-security')

function chooseImages(count) {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: resolve,
      fail: reject
    })
  })
}

function getFileExtension(filePath) {
  const match = String(filePath).match(/\.([a-zA-Z0-9]+)(?:\?|$)/)
  const extension = match ? match[1].toLowerCase() : 'jpg'
  return ['jpg', 'jpeg', 'png', 'gif'].includes(extension) ? extension : 'jpg'
}

Page({
  data: {
    categories: [
      '校园生活',
      '打听求助',
      '失物招领',
      '学习交流',
      '二手闲置',
      '兼职分享',
      '社团活动',
      '吐槽建议',
      '其他'
    ],
    selectedCategory: '校园生活',
    content: '',
    images: [],
    maxImages: MAX_IMAGES,
    isSubmitting: false,
    showVerificationWarning: true
  },

  async onShow() {
    this.setData({ showVerificationWarning: await verification.refresh() })
  },

  openSafetyCenter() { verification.openSafetyCenter() },

  onContentInput(event) {
    this.setData({ content: event.detail.value })
  },

  selectCategory(event) {
    this.setData({ selectedCategory: event.currentTarget.dataset.category })
  },

  async addImages() {
    const remaining = MAX_IMAGES - this.data.images.length
    if (remaining <= 0 || this.data.isSubmitting) {
      return
    }

    try {
      const result = await chooseImages(remaining)
      const selected = result.tempFiles || []
      const valid = selected.filter((file) => Number(file.size || 0) <= MAX_IMAGE_SIZE)
      if (selected.length !== valid.length) {
        wx.showToast({ title: '单张图片不能超过 1MB', icon: 'none' })
      }
      this.setData({ images: this.data.images.concat(valid).slice(0, MAX_IMAGES) })
    } catch (error) {
      if (!String(error.errMsg || error.message).includes('cancel')) {
        console.error('选择帖子图片失败：', error)
        wx.showToast({ title: '选择图片失败', icon: 'none' })
      }
    }
  },

  removeImage(event) {
    if (this.data.isSubmitting) {
      return
    }
    const index = Number(event.currentTarget.dataset.index)
    this.setData({
      images: this.data.images.filter((item, itemIndex) => itemIndex !== index)
    })
  },

  previewImage(event) {
    const urls = this.data.images.map((image) => image.tempFilePath)
    wx.previewImage({ current: urls[Number(event.currentTarget.dataset.index)], urls })
  },

  async getCurrentUser() {
    const app = getApp()
    if (app.globalData.currentUser) {
      return app.globalData.currentUser
    }

    const response = await wx.cloud.callFunction({ name: 'getCurrentUser' })
    const result = response.result || {}
    if (!result.success || !result.user) {
      throw new Error(result.message || '用户身份初始化失败')
    }
    app.globalData.currentUser = result.user
    return result.user
  },

  async uploadImage(userId, image, index) {
    const safeUserId = String(userId).replace(/[^a-zA-Z0-9_-]/g, '')
    const randomText = Math.random().toString(36).slice(2, 9)
    const extension = getFileExtension(image.tempFilePath)
    const result = await wx.cloud.uploadFile({
      cloudPath: `forum-posts/${safeUserId}/${Date.now()}_${index}_${randomText}.${extension}`,
      filePath: image.tempFilePath
    })
    if (!result.fileID) {
      throw new Error('图片上传失败')
    }
    return result.fileID
  },

  async publishPost() {
    if (this.data.isSubmitting) {
      return
    }

    if (wx.getStorageSync('campusPolicyAcceptedVersion') !== '2026-09-02') {
      wx.showModal({
        title: '请先阅读规范',
        content: '发帖前需要阅读并同意用户协议与校园圈社区规范。',
        confirmText: '去阅读',
        success: (result) => {
          if (result.confirm) {
            wx.navigateTo({ url: '/pages/legal/legal' })
          }
        }
      })
      return
    }

    const content = this.data.content.trim()
    if (!content) {
      wx.showToast({ title: '请填写帖子内容', icon: 'none' })
      return
    }

    this.setData({ isSubmitting: true })
    let postImages = []
    try {
      const user = await this.getCurrentUser()
      postImages = await Promise.all(
        this.data.images.map((image, index) => this.uploadImage(user.id, image, index))
      )
      await imageSecurity.checkFiles(postImages, 'POST')
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: {
          action: 'publishPost',
          category: this.data.selectedCategory,
          content,
          postImages
        }
      })
      const result = response.result || {}
      if (!result.success) {
        await imageSecurity.removeFiles(postImages)
        wx.showToast({ title: result.message || '发帖失败', icon: 'none' })
        return
      }

      wx.showToast({ title: '发布成功', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 700)
    } catch (error) {
      console.error('发布校园圈帖子失败：', error)
      await imageSecurity.removeFiles(postImages)
      wx.showToast({ title: error.message || '图片上传或发帖失败', icon: 'none' })
    } finally {
      this.setData({ isSubmitting: false })
    }
  }
})
