const taskStorage = require('../../utils/task-storage')
const orderStorage = require('../../utils/order-storage')
const cloudFile = require('../../utils/cloud-file')

const STATUS_TEXT = {
  WAITING: '待接单',
  ACCEPTED: '已接单',
  WAITING_CONFIRM: '待发布者确认',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  EXPIRED: '已过期'
}

Page({
  data: {
    keyword: '',
    tasks: [],
    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    processingTaskId: '',
    dataSourceText: '正在读取发布记录…'
  },

  onShow() {
    this.loadTasks()
  },

  onPullDownRefresh() {
    this.loadTasks(false).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadTasks(true)
  },

  onSearchInput(event) {
    this.setData({ keyword: event.detail.value })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.loadTasks(false), 350)
  },

  async loadTasks(loadMore = false) {
    if (this.data.isLoading || this.data.isLoadingMore) return
    const page = loadMore ? this.data.page + 1 : 1
    this.setData(loadMore ? { isLoadingMore: true } : { isLoading: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'getMyTaskData',
        data: { type: 'published', page, pageSize: this.data.pageSize, keyword: this.data.keyword }
      })
      const result = response.result || {}

      if (!result.success) {
        throw new Error(result.message || '读取云端发布记录失败')
      }

      const cloudTaskItems = Array.isArray(result.items)
        ? await cloudFile.resolveProofImages(result.items)
        : []
      const cloudTasks = cloudTaskItems.map((task) => ({
          ...task,
          statusText: STATUS_TEXT[task.status] || '未知状态',
          dataSource: 'cloud'
        }))

      if (cloudTasks.length > 0 || Number(result.total || 0) === 0) {
        const tasks = loadMore ? this.data.tasks.concat(cloudTasks) : cloudTasks
        this.setData({
          tasks, page, total: Number(result.total || 0), hasMore: Boolean(result.hasMore),
          dataSourceText: '当前显示 CloudBase 云端发布记录'
        })
        return
      }

      if (getApp().globalData.enableLocalDemo) {
        this.showLocalTasks('云端暂无发布，当前显示本地测试记录')
      } else {
        this.setData({ tasks: [], dataSourceText: '云端暂无发布记录' })
      }
    } catch (error) {
      console.error('getMyTaskData 发布记录读取失败：', error)
      if (getApp().globalData.enableLocalDemo) {
        this.showLocalTasks('云端读取失败，当前显示本地测试记录')
      } else {
        this.setData({ tasks: [], total: 0, hasMore: false, dataSourceText: '云端读取失败，请稍后重试' })
      }
    } finally {
      this.setData({ isLoading: false, isLoadingMore: false })
    }
  },

  showLocalTasks(dataSourceText) {
    const keyword = this.data.keyword.trim().toLowerCase()
    const tasks = taskStorage.getLocalPublishedTasks().filter((item) => !keyword || [item.title, item.category, item.location].filter(Boolean).join(' ').toLowerCase().includes(keyword))
    this.setData({
      tasks, total: tasks.length, hasMore: false,
      dataSourceText
    })
  },

  previewProofImage(event) {
    wx.previewImage({
      current: event.currentTarget.dataset.current,
      urls: event.currentTarget.dataset.urls || []
    })
  },

  openTaskDetail(event) {
    const taskId = event.currentTarget.dataset.id
    const source = event.currentTarget.dataset.source
    if (!taskId) return
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${encodeURIComponent(taskId)}${source === 'cloud' ? '&source=cloud' : ''}`
    })
  },

  goPublish() {
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  openDispute(event) {
    wx.navigateTo({ url: `/pages/dispute-submit/dispute-submit?orderId=${encodeURIComponent(`order_${event.currentTarget.dataset.id}`)}` })
  },

  cancelTask(event) {
    const taskId = event.currentTarget.dataset.id
    if (this.data.processingTaskId) {
      return
    }
    wx.showModal({
      title: '取消任务',
      content: '取消后任务将不能再被接单，确定继续吗？',
      confirmText: '确定取消',
      confirmColor: '#ef4444',
      success: (modalResult) => {
        if (modalResult.confirm) {
          this.cancelCloudTask(taskId)
        }
      }
    })
  },

  async cancelCloudTask(taskId) {
    this.setData({ processingTaskId: taskId })
    try {
      const response = await wx.cloud.callFunction({
        name: 'cancelTask',
        data: { taskId }
      })
      const result = response.result || {}
      if (!result.success) {
        wx.showToast({ title: result.message || '取消失败，请重试', icon: 'none' })
        return
      }
      wx.showToast({ title: '任务已取消', icon: 'success' })
    } catch (error) {
      console.error('cancelTask 云函数调用失败：', error)
      wx.showToast({ title: '云端取消失败，请重试', icon: 'none' })
    } finally {
      this.setData({ processingTaskId: '' })
      await this.loadTasks()
    }
  },

  showConfirmError(reason) {
    const messages = {
      TASK_NOT_FOUND: '任务不存在',
      ORDER_NOT_FOUND: '没有找到对应订单',
      INVALID_TASK_ID: '任务 ID 无效',
      NOT_TASK_PUBLISHER: '只有发布者可以确认完成',
      TASK_ALREADY_COMPLETED: '任务已经完成',
      ORDER_STATUS_CONFLICT: '订单状态与任务不一致',
      TRANSACTION_UNAVAILABLE: '云端事务暂不可用',
      NOT_LOCAL_PUBLISHED: '这不是当前本地发布的任务',
      ALREADY_COMPLETED: '订单已经完成',
      INVALID_TASK_STATUS: '任务还不能确认完成',
      INVALID_ORDER_STATUS: '订单状态不正确',
      STATUS_CHANGED: '任务状态已变化，请刷新'
    }

    wx.showToast({
      title: messages[reason] || '确认失败，请重试',
      icon: 'none'
    })
  },

  confirmCompletion(event) {
    const taskId = event.currentTarget.dataset.id
    const dataSource = event.currentTarget.dataset.source

    if (dataSource === 'cloud') {
      this.confirmCloudTask(taskId)
      return
    }

    if (this.data.processingTaskId) {
      return
    }

    this.setData({ processingTaskId: taskId })

    try {
      const result = orderStorage.confirmTaskCompletion(taskId)

      if (!result.success) {
        this.showConfirmError(result.reason)
      } else {
        wx.showToast({
          title: '订单已完成',
          icon: 'success'
        })
      }
    } catch (error) {
      console.error('确认完成失败：', error)
      this.showConfirmError()
    }

    this.setData({ processingTaskId: '' })
    this.loadTasks()
  },

  async confirmCloudTask(taskId) {
    if (this.data.processingTaskId) {
      return
    }

    this.setData({ processingTaskId: taskId })

    try {
      const response = await wx.cloud.callFunction({
        name: 'confirmTask',
        data: { taskId }
      })
      const result = response.result || {}

      if (!result.success) {
        this.showConfirmError(result.code)
        return
      }

      wx.showToast({
        title: '订单已完成',
        icon: 'success'
      })
    } catch (error) {
      console.error('confirmTask 云函数调用失败：', error)
      this.showConfirmError()
    } finally {
      this.setData({ processingTaskId: '' })
      await this.loadTasks()
    }
  }
})
