const taskStorage = require('../../utils/task-storage')
const orderStorage = require('../../utils/order-storage')
const verification = require('../../utils/verification')

const STATUS_TEXT = {
  WAITING: '待接单',
  ACCEPTED: '已接单',
  WAITING_CONFIRM: '待发布者确认',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  EXPIRED: '已过期'
}

const PROGRESS_CONFIG = {
  WAITING: { completed: 1, copy: '任务已发布，正在等待同学接单' },
  ACCEPTED: { completed: 2, copy: '已有同学接单，任务正在进行中' },
  WAITING_CONFIRM: { completed: 3, copy: '帮助者已提交完成凭证，等待发布者确认' },
  COMPLETED: { completed: 4, copy: '发布者已确认，任务顺利完成' },
  CANCELLED: { completed: 1, copy: '任务已取消，进度已停止', abnormal: true },
  EXPIRED: { completed: 1, copy: '任务已过截止时间，进度已停止', abnormal: true }
}

function withProgress(task) {
  const config = PROGRESS_CONFIG[task.status] || PROGRESS_CONFIG.WAITING
  const labels = ['已发布', '已接单', '已提交', '已完成']
  return {
    ...task,
    progressCopy: config.copy,
    progressAbnormal: Boolean(config.abnormal),
    progressSteps: labels.map((label, index) => ({
      label,
      done: index < config.completed,
      current: !config.abnormal && config.completed < labels.length && index === config.completed,
      lineDone: index + 1 < config.completed
    }))
  }
}

Page({
  data: {
    task: null,
    isAccepting: false,
    isLoading: true,
    showVerificationWarning: true
  },

  onLoad(options) {
    this.taskId = options.id
    this.dataSource = options.source === 'cloud' ? 'cloud' : 'local'
  },

  async onShow() {
    this.setData({ showVerificationWarning: await verification.refresh() })
    if (this.taskId) {
      this.loadTask()
    }
  },

  openSafetyCenter() { verification.openSafetyCenter() },

  async loadTask() {
    if (this.dataSource === 'cloud') {
      await this.loadCloudTask()
      return
    }

    const task = taskStorage.getTaskById(this.taskId)

    if (!task) {
      wx.showToast({
        title: '没有找到该任务',
        icon: 'none'
      })
      this.setData({ isLoading: false })
      return
    }

    this.setData({ task: withProgress(task), isLoading: false })
  },

  async loadCloudTask() {
    this.setData({ isLoading: true })

    try {
      const response = await wx.cloud.callFunction({
        name: 'getTaskDetail',
        data: {
          taskId: this.taskId
        }
      })
      const result = response.result || {}

      if (!result.success || !result.task) {
        wx.showToast({
          title: result.message || '读取任务详情失败',
          icon: 'none'
        })
        this.setData({ task: null, isLoading: false })
        return
      }

      this.setData({
        task: withProgress({
          ...result.task,
          statusText: STATUS_TEXT[result.task.status] || '未知状态'
        }),
        isLoading: false
      })
    } catch (error) {
      console.error('getTaskDetail 调用失败：', error)
      wx.showToast({
        title: '云端任务详情读取失败',
        icon: 'none'
      })
      this.setData({ task: null, isLoading: false })
    }
  },

  showAcceptError(reason) {
    const messages = {
      TASK_NOT_FOUND: '任务不存在',
      INVALID_TASK_ID: '任务 ID 无效',
      SELF_ACCEPT_NOT_ALLOWED: '不能接取自己发布的任务',
      TASK_ALREADY_ACCEPTED: '任务已经被其他同学接取',
      TASK_WAITING_CONFIRM: '任务正在等待发布者确认',
      TASK_ALREADY_COMPLETED: '任务已经完成',
      TASK_CANCELLED: '任务已被发布者取消',
      TASK_EXPIRED: '任务已经超过截止时间',
      TRANSACTION_UNAVAILABLE: '云端事务暂不可用',
      ALREADY_ACCEPTED: '任务已经被接单',
      WAITING_CONFIRM: '任务正在等待发布者确认',
      ALREADY_COMPLETED: '任务已经完成',
      DUPLICATE_ORDER: '该任务已有订单',
      STATUS_CHANGED: '任务状态已变化，请刷新'
    }

    wx.showToast({
      title: messages[reason] || '接单失败，请重试',
      icon: 'none'
    })
  },

  openMyPublished() {
    wx.navigateTo({ url: '/pages/my-published/my-published' })
  },

  acceptTask() {
    if (this.isAccepting) {
      return
    }

    if (!this.data.task) {
      this.showAcceptError('TASK_NOT_FOUND')
      return
    }

    if (this.data.task.isPublisher) {
      this.showAcceptError('SELF_ACCEPT_NOT_ALLOWED')
      return
    }

    if (this.data.task.status !== taskStorage.TASK_STATUS.WAITING) {
      this.showAcceptError(
        this.data.task.status === taskStorage.TASK_STATUS.COMPLETED
          ? 'ALREADY_COMPLETED'
          : 'ALREADY_ACCEPTED'
      )
      return
    }

    if (this.dataSource === 'cloud') {
      this.acceptCloudTask()
      return
    }

    this.isAccepting = true
    this.setData({ isAccepting: true })

    try {
      const result = orderStorage.acceptTask(this.taskId)

      if (!result.success) {
        this.isAccepting = false
        this.setData({ isAccepting: false })
        this.showAcceptError(result.reason)
        this.loadTask()
        return
      }

      wx.showToast({
        title: '接单成功',
        icon: 'success',
        duration: 1000
      })

      setTimeout(() => {
        wx.redirectTo({
          url: '/pages/orders/orders'
        })
      }, 700)
    } catch (error) {
      console.error('接单失败：', error)
      this.isAccepting = false
      this.setData({ isAccepting: false })
      this.showAcceptError()
      this.loadTask()
    }
  },

  async acceptCloudTask() {
    if (this.isAccepting) {
      return
    }

    this.isAccepting = true
    this.setData({ isAccepting: true })

    try {
      const response = await wx.cloud.callFunction({
        name: 'acceptTask',
        data: {
          taskId: this.taskId
        }
      })
      const result = response.result || {}

      if (!result.success) {
        this.showAcceptError(result.code)
        await this.loadTask()
        return
      }

      wx.showToast({
        title: '接单成功',
        icon: 'success',
        duration: 1000
      })

      setTimeout(() => {
        wx.navigateBack()
      }, 700)
    } catch (error) {
      console.error('acceptTask 云函数调用失败：', error)
      this.showAcceptError()
      await this.loadTask()
    } finally {
      this.isAccepting = false
      this.setData({ isAccepting: false })
    }
  }
})
