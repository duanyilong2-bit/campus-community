const categories = ['跑腿', '代购', '打印', '日常事务', '兼职', '其他']
const verification = require('../../utils/verification')

function formatDate(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

Page({
  data: {
    categories,
    categoryIndex: 0,
    title: '',
    description: '',
    reward: '',
    location: '',
    deadlineDate: '',
    deadlineTime: '',
    today: '',
    isAnonymous: false,
    isSubmitting: false,
    showVerificationWarning: true
  },

  onLoad() {
    this.setData({
      today: formatDate(new Date())
    })
  },

  async onShow() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) {
      tabBar.setData({ selected: 2 })
    }
    this.setData({ showVerificationWarning: await verification.refresh() })
  },

  openSafetyCenter() { verification.openSafetyCenter() },

  onTitleInput(event) {
    this.setData({ title: event.detail.value })
  },

  onCategoryChange(event) {
    this.setData({ categoryIndex: Number(event.detail.value) })
  },

  onDescriptionInput(event) {
    this.setData({ description: event.detail.value })
  },

  onRewardInput(event) {
    this.setData({ reward: event.detail.value })
  },

  onLocationInput(event) {
    this.setData({ location: event.detail.value })
  },

  onDeadlineDateChange(event) {
    this.setData({ deadlineDate: event.detail.value })
  },

  onDeadlineTimeChange(event) {
    this.setData({ deadlineTime: event.detail.value })
  },

  onAnonymousChange(event) {
    this.setData({ isAnonymous: Boolean(event.detail.value) })
  },

  showError(message) {
    this.isSubmitting = false
    this.setData({ isSubmitting: false })
    wx.showToast({
      title: message,
      icon: 'none'
    })
  },

  async publishTask() {
    if (this.isSubmitting) {
      return
    }

    if (wx.getStorageSync('campusPolicyAcceptedVersion') !== '2026-09-02') {
      wx.showModal({
        title: '请先阅读协议',
        content: '发布任务前需要阅读并同意用户协议与安全规范。',
        confirmText: '去阅读',
        success: (result) => {
          if (result.confirm) {
            wx.navigateTo({ url: '/pages/legal/legal' })
          }
        }
      })
      return
    }

    this.isSubmitting = true
    this.setData({ isSubmitting: true })

    const title = this.data.title.trim()
    const description = this.data.description.trim()
    const location = this.data.location.trim()
    const rewardText = String(this.data.reward).trim()
    const reward = Number(rewardText)

    if (!title) {
      this.showError('请填写任务标题')
      return
    }

    if (!description) {
      this.showError('请填写任务描述')
      return
    }

    if (!rewardText || !Number.isFinite(reward) || reward < 0) {
      this.showError('请输入有效的非负报酬')
      return
    }

    if (!location) {
      this.showError('请填写任务地点')
      return
    }

    if (!this.data.deadlineDate) {
      this.showError('请选择截止日期')
      return
    }

    if (!this.data.deadlineTime) {
      this.showError('请选择具体截止时间')
      return
    }

    const now = new Date()
    const today = formatDate(now)
    if (this.data.deadlineDate === today && this.data.deadlineTime <= formatTime(now)) {
      this.showError('截止时间必须晚于当前时间')
      return
    }

    const deadline = `${this.data.deadlineDate} ${this.data.deadlineTime}`

    try {
      const response = await wx.cloud.callFunction({
        name: 'publishTask',
        data: {
          title,
          category: categories[this.data.categoryIndex],
          description,
          reward,
          location,
          deadline,
          isAnonymous: this.data.isAnonymous
        }
      })
      const result = response.result || {}

      if (!result.success) {
        this.showError(result.message || '发布失败，请重试')
        return
      }

      wx.showToast({
        title: '发布成功',
        icon: 'success',
        duration: 1000
      })

      setTimeout(() => {
        wx.switchTab({
          url: '/pages/tasks/tasks'
        })
      }, 700)
    } catch (error) {
      console.error('发布云端任务失败：', error)
      this.showError('云端发布失败，请重试')
    }
  }
})
