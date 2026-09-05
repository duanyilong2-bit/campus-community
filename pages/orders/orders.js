const orderStorage = require('../../utils/order-storage')
const cloudFile = require('../../utils/cloud-file')

const STATUS_TEXT = {
  ACCEPTED: '已接单',
  WAITING_CONFIRM: '待发布者确认',
  COMPLETED: '已完成'
}

Page({
  data: {
    keyword: '',
    orders: [],
    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    processingOrderId: '',
    dataSourceText: '正在读取订单…'
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) {
      tabBar.setData({ selected: 3 })
    }
    this.loadOrders()
  },

  onPullDownRefresh() {
    this.loadOrders(false).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadOrders(true)
  },

  onSearchInput(event) {
    this.setData({ keyword: event.detail.value })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.loadOrders(false), 350)
  },

  async loadOrders(loadMore = false) {
    if (this.data.isLoading || this.data.isLoadingMore) return
    const page = loadMore ? this.data.page + 1 : 1
    this.setData(loadMore ? { isLoadingMore: true } : { isLoading: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'getMyTaskData',
        data: { type: 'orders', page, pageSize: this.data.pageSize, keyword: this.data.keyword }
      })
      const result = response.result || {}

      if (!result.success) {
        throw new Error(result.message || '读取云端订单失败')
      }

      const cloudOrderItems = Array.isArray(result.items)
        ? await cloudFile.resolveProofImages(result.items)
        : []
      const cloudOrders = cloudOrderItems.map((order) => ({
          ...order,
          statusText: STATUS_TEXT[order.status] || '未知状态',
          dataSource: 'cloud'
        }))

      if (cloudOrders.length > 0 || Number(result.total || 0) === 0) {
        const orders = loadMore ? this.data.orders.concat(cloudOrders) : cloudOrders
        this.setData({
          orders, page, total: Number(result.total || 0), hasMore: Boolean(result.hasMore),
          dataSourceText: '当前显示 CloudBase 云端订单'
        })
        return
      }

      if (getApp().globalData.enableLocalDemo) {
        this.showLocalOrders('云端暂无订单，当前显示本地测试记录')
      } else {
        this.setData({ orders: [], dataSourceText: '云端暂无订单' })
      }
    } catch (error) {
      console.error('getMyTaskData 订单读取失败：', error)
      if (getApp().globalData.enableLocalDemo) {
        this.showLocalOrders('云端读取失败，当前显示本地测试记录')
      } else {
        this.setData({ orders: [], total: 0, hasMore: false, dataSourceText: '云端读取失败，请稍后重试' })
      }
    } finally {
      this.setData({ isLoading: false, isLoadingMore: false })
    }
  },

  showLocalOrders(dataSourceText) {
    const keyword = this.data.keyword.trim().toLowerCase()
    const orders = orderStorage.getAllOrders().filter((item) => !keyword || [item.title, item.category, item.location].filter(Boolean).join(' ').toLowerCase().includes(keyword))
    this.setData({
      orders, total: orders.length, hasMore: false,
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
    const taskId = event.currentTarget.dataset.taskId
    const source = event.currentTarget.dataset.source
    if (!taskId) return
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${encodeURIComponent(taskId)}${source === 'cloud' ? '&source=cloud' : ''}`
    })
  },

  goTasks() {
    wx.switchTab({ url: '/pages/tasks/tasks' })
  },

  openDispute(event) {
    wx.navigateTo({ url: `/pages/dispute-submit/dispute-submit?orderId=${encodeURIComponent(event.currentTarget.dataset.id)}` })
  },

  showSubmitError(reason) {
    const messages = {
      ORDER_NOT_FOUND: '订单不存在',
      TASK_NOT_FOUND: '对应任务不存在',
      INVALID_ORDER_ID: '订单 ID 无效',
      NOT_ORDER_WORKER: '只有接单者可以提交完成',
      ORDER_ALREADY_SUBMITTED: '任务已经提交完成',
      ORDER_ALREADY_COMPLETED: '订单已经完成',
      INVALID_ORDER_STATUS: '当前订单状态不能提交',
      TASK_STATUS_CONFLICT: '任务状态与订单不一致',
      TRANSACTION_UNAVAILABLE: '云端事务暂不可用',
      ALREADY_SUBMITTED: '任务已经提交完成',
      ALREADY_COMPLETED: '任务已经完成',
      STATUS_CHANGED: '任务状态已变化，请刷新'
    }

    wx.showToast({
      title: messages[reason] || '操作失败，请重试',
      icon: 'none'
    })
  },

  submitTask(event) {
    const orderId = event.currentTarget.dataset.id
    const dataSource = event.currentTarget.dataset.source

    if (dataSource === 'cloud') {
      wx.navigateTo({
        url: `/pages/submit-proof/submit-proof?orderId=${encodeURIComponent(orderId)}`
      })
      return
    }

    if (this.data.processingOrderId) {
      return
    }

    this.setData({ processingOrderId: orderId })

    try {
      const result = orderStorage.submitOrderForConfirmation(orderId)

      if (!result.success) {
        this.showSubmitError(result.reason)
      } else {
        wx.showToast({
          title: '已提交，等待发布者确认',
          icon: 'none'
        })
      }
    } catch (error) {
      console.error('提交完成失败：', error)
      this.showSubmitError()
    }

    this.setData({ processingOrderId: '' })
    this.loadOrders()
  }
})
