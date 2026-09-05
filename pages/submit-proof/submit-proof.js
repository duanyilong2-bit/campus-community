const imageSecurity = require('../../utils/image-security')
const MAX_IMAGES = 3
const MAX_IMAGE_SIZE = 1024 * 1024

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
  const allowedExtensions = ['jpg', 'jpeg', 'png', 'gif']
  return allowedExtensions.includes(extension) ? extension : 'jpg'
}

Page({
  data: {
    proofText: '',
    images: [],
    maxImages: MAX_IMAGES,
    isSubmitting: false
  },

  onLoad(options) {
    this.orderId = String(options.orderId || '')

    if (!this.orderId) {
      wx.showToast({
        title: '订单 ID 无效',
        icon: 'none'
      })
      setTimeout(() => wx.navigateBack(), 800)
    }
  },

  onProofInput(event) {
    this.setData({ proofText: event.detail.value })
  },

  async addImages() {
    const remainingCount = MAX_IMAGES - this.data.images.length

    if (remainingCount <= 0 || this.data.isSubmitting) {
      return
    }

    try {
      const result = await chooseImages(remainingCount)
      const selectedImages = result.tempFiles || []
      const validImages = selectedImages.filter(
        (file) => Number(file.size || 0) <= MAX_IMAGE_SIZE
      )

      if (validImages.length !== selectedImages.length) {
        wx.showToast({
          title: '单张图片不能超过 1MB',
          icon: 'none'
        })
      }

      this.setData({
        images: this.data.images.concat(validImages).slice(0, MAX_IMAGES)
      })
    } catch (error) {
      if (!String(error.errMsg || error.message).includes('cancel')) {
        console.error('选择凭证图片失败：', error)
        wx.showToast({
          title: '选择图片失败',
          icon: 'none'
        })
      }
    }
  },

  removeImage(event) {
    if (this.data.isSubmitting) {
      return
    }

    const index = Number(event.currentTarget.dataset.index)
    const images = this.data.images.filter((item, itemIndex) => itemIndex !== index)
    this.setData({ images })
  },

  previewImage(event) {
    const index = Number(event.currentTarget.dataset.index)
    const urls = this.data.images.map((image) => image.tempFilePath)

    wx.previewImage({
      current: urls[index],
      urls
    })
  },

  async uploadImage(image, index) {
    const safeOrderId = this.orderId.replace(/[^a-zA-Z0-9_-]/g, '')
    const extension = getFileExtension(image.tempFilePath)
    const randomText = Math.random().toString(36).slice(2, 9)
    const cloudPath = `task-proofs/${safeOrderId}/${Date.now()}_${index}_${randomText}.${extension}`
    const result = await wx.cloud.uploadFile({
      cloudPath,
      filePath: image.tempFilePath
    })

    if (!result.fileID) {
      throw new Error('UPLOAD_FILE_ID_MISSING')
    }

    return result.fileID
  },

  async submitProof() {
    if (this.data.isSubmitting) {
      return
    }

    const proofText = this.data.proofText.trim()

    if (!proofText && this.data.images.length === 0) {
      wx.showToast({
        title: '请填写说明或上传图片',
        icon: 'none'
      })
      return
    }

    this.setData({ isSubmitting: true })
    let proofImages = []

    try {
      proofImages = await Promise.all(
        this.data.images.map((image, index) => this.uploadImage(image, index))
      )
      await imageSecurity.checkFiles(proofImages, 'TASK_PROOF', this.orderId)
      const response = await wx.cloud.callFunction({
        name: 'submitTask',
        data: {
          orderId: this.orderId,
          proofText,
          proofImages
        }
      })
      const result = response.result || {}

      if (!result.success) {
        await imageSecurity.removeFiles(proofImages)
        wx.showToast({
          title: result.message || '提交失败，请重试',
          icon: 'none'
        })
        return
      }

      wx.showToast({
        title: '已提交，等待确认',
        icon: 'success',
        duration: 1000
      })

      setTimeout(() => wx.navigateBack(), 700)
    } catch (error) {
      console.error('上传完成凭证失败：', error)
      await imageSecurity.removeFiles(proofImages)
      wx.showToast({
        title: error.message || '图片上传或提交失败',
        icon: 'none'
      })
    } finally {
      this.setData({ isSubmitting: false })
    }
  }
})
