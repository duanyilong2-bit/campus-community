const cloudFile = require('../../utils/cloud-file')

Page({
  data: {
    post: null,
    comments: [],
    commentText: '',
    replyingTo: null,
    editorFocused: false,
    isLoading: true,
    isLiking: false,
    isCommenting: false
  },

  onLoad(options) {
    this.postId = String(options.id || '')
    if (!this.postId) {
      wx.showToast({ title: '帖子 ID 无效', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 700)
    }
  },

  onShow() {
    if (this.postId) {
      this.loadPost()
    }
  },

  async loadPost() {
    this.setData({ isLoading: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: {
          action: 'getPost',
          postId: this.postId,
          recordView: !this.hasRecordedView
        }
      })
      const result = response.result || {}
      if (!result.success || !result.post) {
        wx.showToast({ title: result.message || '帖子不存在', icon: 'none' })
        return
      }

      const resolved = await cloudFile.resolvePostImages([result.post])
      const post = {
        ...resolved[0],
        avatarText: String(result.post.authorName || '校').slice(0, 1)
      }
      this.hasRecordedView = true
      const comments = (Array.isArray(result.comments) ? result.comments : []).map((comment) => ({
        ...comment,
        avatarText: String(comment.authorName || '校').slice(0, 1),
        replies: (Array.isArray(comment.replies) ? comment.replies : []).map((reply) => ({
          ...reply,
          avatarText: String(reply.authorName || '校').slice(0, 1)
        }))
      }))
      this.setData({ post, comments })
    } catch (error) {
      console.error('读取帖子详情失败：', error)
      wx.showToast({ title: '读取帖子失败', icon: 'none' })
    } finally {
      this.setData({ isLoading: false })
    }
  },

  previewImage(event) {
    const current = event.currentTarget.dataset.current
    wx.previewImage({ current, urls: event.currentTarget.dataset.urls || [current] })
  },

  onCommentInput(event) {
    this.setData({ commentText: event.detail.value })
  },

  onEditorBlur() {
    this.setData({ editorFocused: false })
  },

  startReply(event) {
    const id = String(event.currentTarget.dataset.id || '')
    const authorName = String(event.currentTarget.dataset.author || '该同学')
    if (!id) return
    this.setData({ replyingTo: { id, authorName }, editorFocused: true })
  },

  cancelReply() {
    this.setData({ replyingTo: null, editorFocused: false })
  },

  async toggleLike() {
    if (this.data.isLiking || !this.data.post) {
      return
    }

    const previousPost = this.data.post
    const optimisticPost = {
      ...previousPost,
      liked: !previousPost.liked,
      likeCount: Math.max(0, Number(previousPost.likeCount || 0) + (previousPost.liked ? -1 : 1))
    }
    this.setData({ isLiking: true, post: optimisticPost })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'toggleLike', postId: this.postId }
      })
      const result = response.result || {}
      if (!result.success) {
        this.setData({ post: previousPost })
        wx.showToast({ title: result.message || '点赞失败', icon: 'none' })
        return
      }
      this.setData({
        post: { ...this.data.post, liked: result.liked, likeCount: result.likeCount }
      })
    } catch (error) {
      console.error('帖子详情点赞失败：', error)
      this.setData({ post: previousPost })
      wx.showToast({ title: '点赞失败，请重试', icon: 'none' })
    } finally {
      this.setData({ isLiking: false })
    }
  },

  updateCommentLike(commentId, liked, likeCount) {
    return this.data.comments.map((comment) => {
      if (comment.id === commentId) return { ...comment, liked, likeCount }
      return {
        ...comment,
        replies: (comment.replies || []).map((reply) => (
          reply.id === commentId ? { ...reply, liked, likeCount } : reply
        ))
      }
    })
  },

  findComment(commentId) {
    for (const comment of this.data.comments) {
      if (comment.id === commentId) return comment
      const reply = (comment.replies || []).find((item) => item.id === commentId)
      if (reply) return reply
    }
    return null
  },

  async toggleCommentLike(event) {
    const commentId = String(event.currentTarget.dataset.id || '')
    if (!commentId) return
    this.commentLikePending = this.commentLikePending || new Set()
    if (this.commentLikePending.has(commentId)) return
    const previous = this.findComment(commentId)
    if (!previous) return
    const optimisticLiked = !previous.liked
    const optimisticCount = Math.max(0, Number(previous.likeCount || 0) + (previous.liked ? -1 : 1))
    this.commentLikePending.add(commentId)
    this.setData({ comments: this.updateCommentLike(commentId, optimisticLiked, optimisticCount) })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'toggleCommentLike', commentId }
      })
      const result = response.result || {}
      if (!result.success) throw new Error(result.message || '评论点赞失败')
      this.setData({ comments: this.updateCommentLike(commentId, result.liked, result.likeCount) })
    } catch (error) {
      this.setData({ comments: this.updateCommentLike(commentId, previous.liked, previous.likeCount) })
      wx.showToast({ title: error.message || '评论点赞失败', icon: 'none' })
    } finally {
      this.commentLikePending.delete(commentId)
    }
  },

  async submitComment() {
    if (this.data.isCommenting) {
      return
    }

    const content = this.data.commentText.trim()
    if (!content) {
      wx.showToast({ title: '请先填写评论', icon: 'none' })
      return
    }

    const isReply = Boolean(this.data.replyingTo)
    this.setData({ isCommenting: true })
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: {
          action: 'addComment',
          postId: this.postId,
          content,
          replyToCommentId: this.data.replyingTo ? this.data.replyingTo.id : ''
        }
      })
      const result = response.result || {}
      if (!result.success) {
        wx.showToast({ title: result.message || '评论失败', icon: 'none' })
        return
      }
      this.setData({ commentText: '', replyingTo: null, editorFocused: false })
      wx.showToast({ title: isReply ? '回复成功' : '评论成功', icon: 'success' })
      await this.loadPost()
    } catch (error) {
      console.error('发表评论失败：', error)
      wx.showToast({ title: '评论失败，请重试', icon: 'none' })
    } finally {
      this.setData({ isCommenting: false })
    }
  },

  handlePostMenu() {
    if (!this.data.post) {
      return
    }
    if (this.data.post.isAuthor) {
      wx.showModal({
        title: '删除帖子',
        content: '帖子、评论和帖子图片都会被删除，且无法恢复。',
        confirmText: '确认删除',
        confirmColor: '#e5484d',
        success: async (result) => {
          if (result.confirm) {
            await this.deletePost()
          }
        }
      })
      return
    }

    const reasons = ['广告营销', '不友善内容', '虚假信息', '泄露隐私', '其他']
    wx.showActionSheet({
      itemList: reasons,
      success: (result) => this.reportPost(reasons[result.tapIndex])
    })
  },

  async deletePost() {
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'deletePost', postId: this.postId }
      })
      const result = response.result || {}
      if (!result.success) {
        wx.showToast({ title: result.message || '删除失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '帖子已删除', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    } catch (error) {
      console.error('删除帖子失败：', error)
      wx.showToast({ title: '删除失败，请重试', icon: 'none' })
    }
  },

  async reportPost(reason) {
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'reportPost', postId: this.postId, reason }
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
  },

  confirmDeleteComment(event) {
    const commentId = event.currentTarget.dataset.id
    wx.showModal({
      title: '删除评论',
      content: '确认删除这条评论吗？',
      confirmText: '删除',
      confirmColor: '#e5484d',
      success: async (result) => {
        if (result.confirm) {
          await this.deleteComment(commentId)
        }
      }
    })
  },

  async deleteComment(commentId) {
    try {
      const response = await wx.cloud.callFunction({
        name: 'forumApi',
        data: { action: 'deleteComment', commentId }
      })
      const result = response.result || {}
      if (!result.success) {
        wx.showToast({ title: result.message || '删除评论失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '评论已删除', icon: 'success' })
      await this.loadPost()
    } catch (error) {
      console.error('删除评论失败：', error)
      wx.showToast({ title: '删除评论失败', icon: 'none' })
    }
  }
})
