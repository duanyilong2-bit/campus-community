const cloudFile = require('../../utils/cloud-file')

Page({
  data: {
    keyword: '',
    selectedCategory: '全部',
    categories: [
      '全部',
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
    posts: [],
    hotPost: null,
    hotRule: '浏览量 + 点赞量 × 3',
    page: 1,
    pageSize: 10,
    total: 0,
    hasMore: false,
    unreadCount: 0,
    isLoading: false,
    isLoadingMore: false,
    processingPostId: '',
    dataSourceText: '正在读取文华校园圈…'
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) {
      tabBar.setData({ selected: 1 })
    }
    this.loadPosts()
    this.loadUnreadCount()
  },

  onPullDownRefresh() {
    this.loadPosts(false).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore) this.loadPosts(true)
  },

  async loadPosts(loadMore = false) {
    if (this.data.isLoading || this.data.isLoadingMore) {
      return
    }

    const page = loadMore ? this.data.page + 1 : 1
    this.setData(loadMore ? { isLoadingMore: true } : { isLoading: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: {
          action: 'listPosts', page, pageSize: this.data.pageSize,
          keyword: this.data.keyword, category: this.data.selectedCategory
        }
      })
      const result = response.result || {}
      if (!result.success) {
        throw new Error(result.message || '读取帖子失败')
      }

      const postsWithImages = await cloudFile.resolvePostImages(
        Array.isArray(result.posts) ? result.posts : []
      )
      const currentPosts = postsWithImages.map((post) => ({
        ...post,
        avatarText: String(post.authorName || '校').slice(0, 1)
      }))
      this.allPosts = loadMore ? (this.allPosts || []).concat(currentPosts) : currentPosts
      const hotPost = result.hotPost
        ? this.allPosts.find((post) => post.id === result.hotPost.id) || {
          ...result.hotPost,
          avatarText: String(result.hotPost.authorName || '校').slice(0, 1)
        }
        : null
      this.setData({
        hotPost,
        hotRule: result.hotRule || '浏览量 + 点赞量 × 3',
        posts: this.allPosts,
        page,
        total: Number(result.total || 0),
        hasMore: Boolean(result.hasMore),
        dataSourceText: '内容来自文华学院 CloudBase 校园圈'
      })
    } catch (error) {
      console.error('读取校园圈失败：', error)
      if (!loadMore) {
        this.allPosts = []
        this.setData({ posts: [], hotPost: null, total: 0, hasMore: false, dataSourceText: '校园圈暂时无法连接，请稍后重试' })
      }
    } finally {
      this.setData({ isLoading: false, isLoadingMore: false })
    }
  },

  onSearchInput(event) {
    this.setData({ keyword: event.detail.value })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.loadPosts(false), 350)
  },

  selectCategory(event) {
    this.setData({ selectedCategory: event.currentTarget.dataset.category })
    this.loadPosts(false)
  },

  openPublishPost() {
    wx.navigateTo({ url: '/pages/forum-publish/forum-publish' })
  },

  openNotifications() {
    wx.navigateTo({ url: '/pages/notifications/notifications' })
  },

  async loadUnreadCount() {
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'getNotificationSummary' }
      })
      const result = response.result || {}
      if (result.success) {
        this.setData({ unreadCount: Number(result.unreadCount || 0) })
      }
    } catch (error) {
      console.error('读取校园圈未读消息失败：', error)
    }
  },

  openPost(event) {
    wx.navigateTo({
      url: `/pages/forum-detail/forum-detail?id=${encodeURIComponent(event.currentTarget.dataset.id)}`
    })
  },

  previewImage(event) {
    const current = event.currentTarget.dataset.current
    wx.previewImage({ current, urls: event.currentTarget.dataset.urls || [current] })
  },

  async toggleLike(event) {
    const postId = event.currentTarget.dataset.id
    if (this.data.processingPostId) {
      return
    }

    this.setData({ processingPostId: postId })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'toggleLike', postId }
      })
      const result = response.result || {}
      if (!result.success) {
        wx.showToast({ title: result.message || '点赞失败', icon: 'none' })
        return
      }

      this.allPosts = (this.allPosts || []).map((post) => (
        post.id === postId
          ? { ...post, liked: result.liked, likeCount: result.likeCount }
          : post
      ))
      if (this.data.hotPost && this.data.hotPost.id === postId) {
        this.setData({
          hotPost: {
            ...this.data.hotPost,
            liked: result.liked,
            likeCount: result.likeCount,
            hotScore: Number(this.data.hotPost.viewCount || 0) + Number(result.likeCount || 0) * 3
          }
        })
      }
      this.setData({ posts: this.allPosts })
    } catch (error) {
      console.error('点赞失败：', error)
      wx.showToast({ title: '点赞失败，请重试', icon: 'none' })
    } finally {
      this.setData({ processingPostId: '' })
    }
  },

  handlePostMenu(event) {
    const postId = event.currentTarget.dataset.id
    const isAuthor = event.currentTarget.dataset.author === true || event.currentTarget.dataset.author === 'true'
    if (isAuthor) {
      wx.showActionSheet({
        itemList: ['删除帖子'],
        itemColor: '#e5484d',
        success: () => this.confirmDeletePost(postId)
      })
      return
    }

    const reasons = ['广告营销', '不友善内容', '虚假信息', '泄露隐私', '其他']
    wx.showActionSheet({
      itemList: reasons,
      success: (result) => this.reportPost(postId, reasons[result.tapIndex])
    })
  },

  confirmDeletePost(postId) {
    wx.showModal({
      title: '删除帖子',
      content: '帖子、评论和帖子图片都会被删除，且无法恢复。',
      confirmText: '确认删除',
      confirmColor: '#e5484d',
      success: async (result) => {
        if (!result.confirm) {
          return
        }
        await this.deletePost(postId)
      }
    })
  },

  async deletePost(postId) {
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'deletePost', postId }
      })
      const result = response.result || {}
      if (!result.success) {
        wx.showToast({ title: result.message || '删除失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '帖子已删除', icon: 'success' })
      await this.loadPosts()
    } catch (error) {
      console.error('删除帖子失败：', error)
      wx.showToast({ title: '删除失败，请重试', icon: 'none' })
    }
  },

  async reportPost(postId, reason) {
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'reportPost', postId, reason }
      })
      const result = response.result || {}
      wx.showToast({
        title: result.success ? '举报已提交' : (result.message || '举报失败'),
        icon: result.success ? 'success' : 'none'
      })
    } catch (error) {
      console.error('举报帖子失败：', error)
      wx.showToast({ title: '举报失败，请重试', icon: 'none' })
    }
  }
})
