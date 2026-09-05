const taskStorage = require('../../utils/task-storage')

const STATUS_TEXT = {
  WAITING: '待接单',
  ACCEPTED: '已接单',
  WAITING_CONFIRM: '待确认',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  EXPIRED: '已过期'
}

function formatTask(task, dataSource) {
  return {
    ...task,
    avatarText: task.category ? task.category.slice(0, 1) : '任',
    statusText: STATUS_TEXT[task.status] || task.statusText || '未知状态',
    dataSource
  }
}

function formatPost(post) {
  return {
    ...post,
    avatarText: String(post.authorName || '文华同学').slice(0, 1),
    imageCount: Array.isArray(post.postImages) ? post.postImages.length : 0
  }
}

Page({
  data: {
    schoolName: '文华学院',
    keyword: '',
    isSearching: false,
    quickServices: [
      { name: '跑腿代办', category: '跑腿', icon: '跑', tone: 'blue' },
      { name: '打印资料', category: '打印', icon: '印', tone: 'cyan' },
      { name: '代购带饭', category: '代购', icon: '购', tone: 'orange' },
      { name: '兼职任务', category: '兼职', icon: '职', tone: 'purple' }
    ],
    posts: [],
    tasks: [],
    homeTask: null,
    homeTaskTotal: 0,
    postSourceText: '正在读取校园动态…',
    taskSourceText: '正在读取校园互助任务…',
    isLoading: false
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) {
      tabBar.setData({ selected: 0 })
    }
    this.loadHomeContent()
  },

  onPullDownRefresh() {
    this.loadHomeContent().finally(() => wx.stopPullDownRefresh())
  },

  async loadHomeContent() {
    if (this.data.isLoading) {
      return
    }
    this.setData({ isLoading: true })

    const keyword = this.data.keyword.trim()
    const [taskResponse, postResponse, homeProgressResponse] = await Promise.all([
      wx.cloud.callFunction({ name: 'listTasks', data: { keyword, page: 1, pageSize: keyword ? 20 : 3, filter: 'ALL' } }).catch((error) => ({ error })),
      wx.cloud.callFunction({ name: 'forumApi', data: { action: 'listPosts', keyword, page: 1, pageSize: keyword ? 20 : 3, category: '全部' } }).catch((error) => ({ error })),
      keyword
        ? Promise.resolve(null)
        : wx.cloud.callFunction({ name: 'getMyTaskData', data: { type: 'home' } }).catch((error) => ({ error }))
    ])

    this.loadTaskResult(taskResponse)
    this.loadPostResult(postResponse)
    if (!keyword) this.loadHomeProgressResult(homeProgressResponse)
    this.applySearch()
    this.setData({ isLoading: false })
  },

  loadTaskResult(response) {
    const result = response && response.result ? response.result : {}
    if (result.success && Array.isArray(result.tasks)) {
      this.allTasks = result.tasks.map((task) => formatTask(task, 'cloud'))
      this.setData({ taskSourceText: '来自文华学院校园互助' })
      return
    }

    if (response && response.error) {
      console.error('首页读取云端任务失败：', response.error)
    }
    if (getApp().globalData.enableLocalDemo) {
      this.allTasks = taskStorage.getAllTasks().map((task) => formatTask(task, 'local'))
      this.setData({ taskSourceText: '云端暂不可用，当前显示本地演示任务' })
    } else {
      this.allTasks = []
      this.setData({ taskSourceText: '校园互助任务暂时无法连接' })
    }
  },

  loadPostResult(response) {
    const result = response && response.result ? response.result : {}
    if (result.success && Array.isArray(result.posts)) {
      this.allPosts = result.posts.map(formatPost)
      this.setData({ postSourceText: '来自文华学院校园圈' })
      return
    }

    if (response && response.error) {
      console.error('首页读取校园帖子失败：', response.error)
    }
    this.allPosts = []
    this.setData({ postSourceText: '校园动态暂时无法连接' })
  },

  loadHomeProgressResult(response) {
    const result = response && response.result ? response.result : {}
    if (!result.success) {
      if (response && response.error) console.error('首页读取个人任务进度失败：', response.error)
      this.setData({ homeTask: null, homeTaskTotal: 0 })
      return
    }
    const homeTask = result.item || null
    this.setData({ homeTask, homeTaskTotal: Number(result.total || 0) })
    if (homeTask && homeTask.status === 'COMPLETED') {
      setTimeout(() => this.markCompletedHomeTaskSeen(homeTask), 700)
    }
  },

  async markCompletedHomeTaskSeen(homeTask) {
    const markKey = `${homeTask.role}:${homeTask.sourceId}`
    if (this.markedHomeTasks && this.markedHomeTasks.has(markKey)) return
    if (!this.markedHomeTasks) this.markedHomeTasks = new Set()
    this.markedHomeTasks.add(markKey)
    try {
      const response = await wx.cloud.callFunction({
        name: 'getMyTaskData',
        data: { type: 'markHomeProgressSeen', role: homeTask.role, sourceId: homeTask.sourceId }
      })
      const result = response.result || {}
      if (!result.success) this.markedHomeTasks.delete(markKey)
    } catch (error) {
      this.markedHomeTasks.delete(markKey)
      console.error('保存已查看任务进度失败：', error)
    }
  },

  onSearchInput(event) {
    this.setData({ keyword: event.detail.value })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.loadHomeContent(), 350)
  },

  clearSearch() {
    this.setData({ keyword: '' })
    this.loadHomeContent()
  },

  applySearch() {
    const keyword = this.data.keyword.trim().toLowerCase()
    const taskSource = Array.isArray(this.allTasks) ? this.allTasks : []
    const postSource = Array.isArray(this.allPosts) ? this.allPosts : []

    const matchedTasks = taskSource.filter((task) => (
      [task.title, task.description, task.location, task.category]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    ))
    const matchedPosts = postSource.filter((post) => (
      [post.content, post.category, post.authorName]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(keyword)
    ))

    this.setData({
      isSearching: Boolean(keyword),
      posts: (keyword ? matchedPosts : postSource).slice(0, keyword ? 20 : 3),
      tasks: (keyword ? matchedTasks : taskSource).slice(0, keyword ? 20 : 3)
    })
  },

  selectQuickService(event) {
    const category = event.currentTarget.dataset.category
    wx.setStorageSync('campusTaskFilter', category)
    wx.switchTab({ url: '/pages/tasks/tasks' })
  },

  openPublishMenu() {
    wx.showActionSheet({
      itemList: ['发布校园帖子', '发布互助任务'],
      success: (result) => {
        if (result.tapIndex === 0) {
          wx.navigateTo({ url: '/pages/forum-publish/forum-publish' })
        } else if (result.tapIndex === 1) {
          wx.switchTab({ url: '/pages/publish/publish' })
        }
      }
    })
  },

  goForum() {
    wx.switchTab({ url: '/pages/forum/forum' })
  },

  openPost(event) {
    wx.navigateTo({
      url: `/pages/forum-detail/forum-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}`
    })
  },

  openTaskHall() {
    wx.switchTab({ url: '/pages/tasks/tasks' })
  },

  openHomeTaskList() {
    const homeTask = this.data.homeTask
    if (!homeTask) return
    wx.navigateTo({ url: homeTask.role === 'PUBLISHER' ? '/pages/my-published/my-published' : '/pages/orders/orders' })
  },

  openTaskDetail(event) {
    const dataset = event.currentTarget.dataset
    const taskId = dataset.id
    const dataSource = dataset.source
    if (dataset.role === 'WORKER' && dataset.status === 'ACCEPTED' && dataset.orderId) {
      wx.navigateTo({
        url: `/pages/submit-proof/submit-proof?orderId=${encodeURIComponent(dataset.orderId)}`
      })
      return
    }
    if (dataset.role === 'PUBLISHER' && dataset.status === 'WAITING_CONFIRM' && taskId) {
      wx.navigateTo({
        url: `/pages/task-confirm/task-confirm?taskId=${encodeURIComponent(taskId)}`
      })
      return
    }
    const sourceQuery = dataSource === 'cloud' ? '&source=cloud' : ''
    wx.navigateTo({
      url: `/pages/task-detail/task-detail?id=${encodeURIComponent(taskId)}${sourceQuery}`
    })
  }
})
