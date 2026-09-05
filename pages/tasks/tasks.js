const taskStorage = require('../../utils/task-storage')

const STATUS_TEXT = {
  WAITING: '待接单',
  ACCEPTED: '已接单',
  WAITING_CONFIRM: '待发布者确认',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  EXPIRED: '已过期'
}

function formatTask(task, dataSource) {
  return {
    ...task,
    statusText: STATUS_TEXT[task.status] || task.statusText || '未知状态',
    actionText: task.status === 'WAITING' ? '接单' : '查看',
    dataSource
  }
}

Page({
  data: {
    filters: [
      { label: '待接单', value: 'WAITING' },
      { label: '全部', value: 'ALL' },
      { label: '跑腿', value: '跑腿' },
      { label: '代购', value: '代购' },
      { label: '打印', value: '打印' },
      { label: '兼职', value: '兼职' }
    ],
    selectedFilter: 'WAITING',
    keyword: '',
    tasks: [],
    page: 1,
    pageSize: 12,
    total: 0,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    dataSourceText: '正在读取任务…'
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) {
      tabBar.setData({ selected: 3 })
    }
    const pendingFilter = wx.getStorageSync('campusTaskFilter')
    if (pendingFilter) {
      wx.removeStorageSync('campusTaskFilter')
      this.setData({ selectedFilter: pendingFilter })
    }
    this.loadTasks()
  },

  onPullDownRefresh() {
    this.loadTasks(false).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadTasks(true)
  },

  async loadTasks(loadMore = false) {
    if (this.data.isLoading || this.data.isLoadingMore) return
    const page = loadMore ? this.data.page + 1 : 1
    this.setData(loadMore ? { isLoadingMore: true } : { isLoading: true })
    try {
      const response = await wx.cloud.callFunction({ name: 'listTasks', data: {
        page, pageSize: this.data.pageSize, keyword: this.data.keyword, filter: this.data.selectedFilter
      } })
      const result = response.result || {}

      if (!result.success) {
        throw new Error(`${result.code || ''} ${result.message || '读取云端任务失败'}`)
      }

      const cloudTasks = Array.isArray(result.tasks)
        ? result.tasks.map((task) => formatTask(task, 'cloud'))
        : []

      if (cloudTasks.length > 0 || Number(result.total || 0) === 0) {
        this.allTasks = loadMore ? (this.allTasks || []).concat(cloudTasks) : cloudTasks
        this.setData({ tasks: this.allTasks, page, total: Number(result.total || 0), hasMore: Boolean(result.hasMore), dataSourceText: '文华学院 CloudBase 云端任务' })
        return
      }

      if (getApp().globalData.enableLocalDemo) {
        this.showLocalTasks('云端暂无任务，当前显示本地演示数据')
      } else {
        this.allTasks = []
        this.setData({ tasks: [], dataSourceText: '云端暂无任务' })
      }
    } catch (error) {
      console.error('listTasks 调用失败，已保留本地任务：', error)
      if (getApp().globalData.enableLocalDemo) {
        this.showLocalTasks('云端读取失败，当前显示本地演示数据')
      } else {
        this.allTasks = []
        this.setData({ tasks: [], total: 0, hasMore: false, dataSourceText: '云端读取失败，请稍后重试' })
      }
    } finally {
      this.setData({ isLoading: false, isLoadingMore: false })
    }
  },

  showLocalTasks(dataSourceText) {
    this.allTasks = taskStorage.getAllTasks().map((task) => formatTask(task, 'local'))
    this.setData({ dataSourceText })
    this.applyFilter()
  },

  selectFilter(event) {
    this.setData({ selectedFilter: event.currentTarget.dataset.value })
    this.loadTasks(false)
  },

  onSearchInput(event) {
    this.setData({ keyword: event.detail.value })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.loadTasks(false), 350)
  },

  applyFilter() {
    const selected = this.data.selectedFilter
    const keyword = this.data.keyword.trim().toLowerCase()
    const source = Array.isArray(this.allTasks) ? this.allTasks : []
    const tasks = source.filter((task) => {
      const filterMatched = selected === 'ALL' || (selected === 'WAITING' ? task.status === 'WAITING' : task.category === selected)
      const keywordMatched = !keyword || [task.title, task.description, task.location, task.category].filter(Boolean).join(' ').toLowerCase().includes(keyword)
      return filterMatched && keywordMatched
    })
    this.setData({ tasks, total: tasks.length, hasMore: false })
  },

  goPublish() {
    wx.switchTab({ url: '/pages/publish/publish' })
  },

  openTaskDetail(event) {
    const taskId = event.currentTarget.dataset.id
    const dataSource = event.currentTarget.dataset.source
    const sourceQuery = dataSource === 'cloud' ? '&source=cloud' : ''
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${encodeURIComponent(taskId)}${sourceQuery}`
    })
  }
})
