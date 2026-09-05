const cloudFile = require('../../utils/cloud-file')

Page({
  data: {
    keyword: '',
    posts: [],
    page: 1, pageSize: 10, total: 0, hasMore: false,
    isLoading: false, isLoadingMore: false
  },

  onShow() {
    this.loadPosts()
  },

  onPullDownRefresh() {
    this.loadPosts(false).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() { if (this.data.hasMore) this.loadPosts(true) },

  onSearchInput(event) {
    this.setData({ keyword: event.detail.value })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.loadPosts(false), 350)
  },

  async loadPosts(loadMore = false) {
    if (this.data.isLoading || this.data.isLoadingMore) return
    const page = loadMore ? this.data.page + 1 : 1
    this.setData(loadMore ? { isLoadingMore: true } : { isLoading: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'listMyPosts', page, pageSize: this.data.pageSize, keyword: this.data.keyword }
      })
      const result = response.result || {}
      if (!result.success) {
        throw new Error(result.message || '读取我的帖子失败')
      }
      const posts = await cloudFile.resolvePostImages(
        Array.isArray(result.posts) ? result.posts : []
      )
      const combined = loadMore ? this.data.posts.concat(posts) : posts
      this.setData({ posts: combined, page, total: Number(result.total || 0), hasMore: Boolean(result.hasMore) })
    } catch (error) {
      console.error('读取我的帖子失败：', error)
      wx.showToast({ title: '读取帖子失败', icon: 'none' })
    } finally {
      this.setData({ isLoading: false, isLoadingMore: false })
    }
  },

  openPost(event) {
    wx.navigateTo({
      url: `/pages/forum-detail/forum-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}`
    })
  },

  openPublish() {
    wx.navigateTo({ url: '/pages/forum-publish/forum-publish' })
  },

  previewImage(event) {
    const current = event.currentTarget.dataset.current
    wx.previewImage({ current, urls: event.currentTarget.dataset.urls || [current] })
  }
})
