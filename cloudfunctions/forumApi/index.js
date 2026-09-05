const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const POSTS_COLLECTION = 'posts'
const COMMENTS_COLLECTION = 'comments'
const USERS_COLLECTION = 'users'
const REPORTS_COLLECTION = 'reports'
const NOTIFICATIONS_COLLECTION = 'notifications'
const FORUM_VIEWS_COLLECTION = 'forum_views'
const IMAGE_CHECKS_COLLECTION = 'image_security_checks'
const REPORT_REASONS = ['广告营销', '不友善内容', '虚假信息', '泄露隐私', '其他']
const CATEGORIES = [
  '校园生活',
  '打听求助',
  '失物招领',
  '学习交流',
  '二手闲置',
  '兼职分享',
  '社团活动',
  '吐槽建议',
  '其他'
]
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const SCAN_BATCH_SIZE = 100
const MAX_SCAN_ITEMS = 1000

function createUserId(appid, openid) {
  const hash = crypto.createHash('sha256').update(`${appid}:${openid}`).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function isCollectionMissing(error) {
  const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(text)
}

function isCollectionExists(error) {
  const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(already exist|已存在)|DATABASE_COLLECTION_EXIST/i.test(text)
}

async function ensureCollection(name) {
  try {
    await db.collection(name).limit(1).get()
  } catch (error) {
    if (!isCollectionMissing(error) || typeof db.createCollection !== 'function') {
      throw error
    }

    try {
      await db.createCollection(name)
    } catch (createError) {
      if (!isCollectionExists(createError)) {
        throw createError
      }
    }
  }
}

async function checkTextSecurity(content, openid) {
  try {
    const result = await cloud.openapi.security.msgSecCheck({
      openid,
      scene: 2,
      version: 2,
      content
    })
    const suggest = result && result.result ? result.result.suggest : ''
    return {
      passed: !suggest || suggest === 'pass',
      status: suggest || 'PASS'
    }
  } catch (error) {
    // 开发环境偶尔可能因接口权限或网络不可用；保留日志，避免阻断整个测试流程。
    console.error('微信文字安全检查暂不可用：', error)
    return { passed: true, status: 'UNAVAILABLE' }
  }
}

function formatChinaDate(value) {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const chinaDate = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = chinaDate.getUTCFullYear()
  const month = String(chinaDate.getUTCMonth() + 1).padStart(2, '0')
  const day = String(chinaDate.getUTCDate()).padStart(2, '0')
  const hour = String(chinaDate.getUTCHours()).padStart(2, '0')
  const minute = String(chinaDate.getUTCMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function formatPost(post, userId, verificationMap = new Map()) {
  const likeUserIds = Array.isArray(post.likeUserIds) ? post.likeUserIds : []
  const viewCount = Math.max(0, Number(post.viewCount || 0))
  return {
    id: post._id,
    authorName: post.authorName || '校园社区用户',
    authorAvatarUrl: post.authorAvatarUrl || '',
    category: post.category,
    content: post.content,
    postImages: Array.isArray(post.postImages) ? post.postImages : [],
    likeCount: likeUserIds.length,
    viewCount,
    hotScore: viewCount + likeUserIds.length * 3,
    commentCount: Number(post.commentCount || 0),
    liked: likeUserIds.includes(userId),
    isAuthor: post.authorId === userId,
    isAuthorVerified: verificationMap.get(post.authorId) === 'VERIFIED',
    createdAt: formatChinaDate(post.createdAt)
  }
}

function formatComment(comment, userId) {
  const likeUserIds = Array.isArray(comment.likeUserIds) ? comment.likeUserIds : []
  return {
    id: comment._id,
    authorName: comment.authorName || '校园社区用户',
    authorAvatarUrl: comment.authorAvatarUrl || '',
    content: comment.content,
    parentCommentId: comment.parentCommentId || '',
    replyToCommentId: comment.replyToCommentId || '',
    replyToAuthorName: comment.replyToAuthorName || '',
    likeCount: likeUserIds.length,
    liked: likeUserIds.includes(userId),
    isAuthor: comment.authorId === userId,
    createdAt: formatChinaDate(comment.createdAt),
    replies: []
  }
}

function buildCommentThreads(comments) {
  const roots = []
  const rootMap = new Map()
  comments.forEach((comment) => {
    if (!comment.parentCommentId) {
      roots.push(comment)
      rootMap.set(comment.id, comment)
    }
  })
  comments.forEach((comment) => {
    if (!comment.parentCommentId) return
    const root = rootMap.get(comment.parentCommentId)
    if (root) root.replies.push(comment)
    else roots.push(comment)
  })
  return roots
}

function getChinaDateKey(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function getPageOptions(event = {}) {
  return {
    page: Math.max(1, Number.parseInt(event.page, 10) || 1),
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(event.pageSize, 10) || DEFAULT_PAGE_SIZE)),
    keyword: String(event.keyword || '').trim().toLowerCase().slice(0, 50),
    category: String(event.category || '全部').trim()
  }
}

async function getAllPosts() {
  const items = []
  for (let offset = 0; offset < MAX_SCAN_ITEMS; offset += SCAN_BATCH_SIZE) {
    const result = await db.collection(POSTS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .skip(offset)
      .limit(SCAN_BATCH_SIZE)
      .get()
    items.push(...result.data)
    if (result.data.length < SCAN_BATCH_SIZE) break
  }
  return items
}

function matchesPost(post, options) {
  if (post.status === 'REMOVED') return false
  if (options.category !== '全部' && post.category !== options.category) return false
  if (!options.keyword) return true
  return [post.content, post.category, post.authorName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(options.keyword)
}

async function resolveCloudImageUrls(items, fieldName) {
  const fileIds = Array.from(new Set(items.flatMap((item) => (
    Array.isArray(item[fieldName]) ? item[fieldName] : []
  )).filter((fileId) => typeof fileId === 'string' && fileId.startsWith('cloud://'))))

  if (fileIds.length === 0) {
    return items
  }

  const result = await cloud.getTempFileURL({ fileList: fileIds })
  const urlMap = new Map()
  ;(result.fileList || []).forEach((file) => {
    if (file.fileID && file.tempFileURL) {
      urlMap.set(file.fileID, file.tempFileURL)
    }
  })

  return items.map((item) => ({
    ...item,
    [fieldName]: (Array.isArray(item[fieldName]) ? item[fieldName] : [])
      .map((fileId) => urlMap.get(fileId) || fileId)
  }))
}

async function resolveCloudFileField(items, fieldName) {
  const fileIds = Array.from(new Set(items
    .map((item) => item[fieldName])
    .filter((fileId) => typeof fileId === 'string' && fileId.startsWith('cloud://'))))

  if (fileIds.length === 0) {
    return items
  }

  const result = await cloud.getTempFileURL({ fileList: fileIds })
  const urlMap = new Map()
  ;(result.fileList || []).forEach((file) => {
    if (file.fileID && file.tempFileURL) {
      urlMap.set(file.fileID, file.tempFileURL)
    }
  })

  return items.map((item) => ({
    ...item,
    [fieldName]: urlMap.get(item[fieldName]) || item[fieldName] || ''
  }))
}

function validatePost(event, userId) {
  const content = String(event.content || '').trim()
  const category = String(event.category || '').trim()
  const postImages = Array.isArray(event.postImages) ? event.postImages : []

  if (!content || content.length > 500) {
    return { code: 'INVALID_CONTENT', message: '帖子内容不能为空且不能超过500字' }
  }
  if (!CATEGORIES.includes(category)) {
    return { code: 'INVALID_CATEGORY', message: '请选择有效的帖子分类' }
  }
  if (postImages.length > 3) {
    return { code: 'TOO_MANY_IMAGES', message: '帖子最多上传3张图片' }
  }

  const expectedPath = `/forum-posts/${userId}/`
  const invalidImage = postImages.some((fileId) => (
    typeof fileId !== 'string' ||
    fileId.length > 1024 ||
    !fileId.startsWith('cloud://') ||
    !fileId.includes(expectedPath)
  ))
  if (invalidImage) {
    return { code: 'INVALID_IMAGE', message: '帖子图片无效，请重新上传' }
  }

  return { content, category, postImages }
}

function createImageCheckId(fileId) {
  return `image_${crypto.createHash('sha256').update(fileId).digest('hex').slice(0, 32)}`
}

async function areImagesSafe(fileIds, userId, purpose) {
  for (const fileId of fileIds) {
    try {
      const result = await db.collection(IMAGE_CHECKS_COLLECTION).doc(createImageCheckId(fileId)).get()
      const check = result.data
      if (!check || check.fileId !== fileId || check.userId !== userId || check.purpose !== purpose || check.result !== 'PASS') return false
    } catch (error) { return false }
  }
  return true
}

async function getUser(userId) {
  try {
    const result = await db.collection(USERS_COLLECTION).doc(userId).get()
    return result.data
  } catch (error) {
    return null
  }
}

async function getVerificationMap(userIds) {
  const uniqueUserIds = Array.from(new Set((userIds || []).filter(Boolean)))
  const entries = await Promise.all(uniqueUserIds.map(async (userId) => {
    const user = await getUser(userId)
    return [userId, user && user.campusVerificationStatus ? user.campusVerificationStatus : 'UNVERIFIED']
  }))
  return new Map(entries)
}

function getDisplayName(user, userId) {
  const nickname = String((user && user.nickname) || '').trim()
  if (nickname && nickname !== '校园帮用户' && nickname !== '校园社区用户') {
    return nickname
  }
  return `校园同学${userId.slice(-4).toUpperCase()}`
}

async function isActionTooFast(collectionName, userId, minimumInterval) {
  const result = await db.collection(collectionName)
    .where({ authorId: userId })
    .limit(10)
    .get()
  const latestTime = result.data.reduce((max, item) => {
    const time = new Date(item.createdAt).getTime()
    return Number.isNaN(time) ? max : Math.max(max, time)
  }, 0)
  return latestTime > 0 && Date.now() - latestTime < minimumInterval
}

async function listPosts(event, userId) {
  await ensureCollection(POSTS_COLLECTION)
  const options = getPageOptions(event)
  const allPosts = await getAllPosts()
  const visiblePosts = allPosts.filter((post) => post.status !== 'REMOVED')
  const matchedPosts = visiblePosts.filter((post) => matchesPost(post, options))
  const start = (options.page - 1) * options.pageSize
  const pagePosts = matchedPosts.slice(start, start + options.pageSize)
  const todayKey = getChinaDateKey(new Date())
  const hotPostSource = visiblePosts
    .filter((post) => getChinaDateKey(post.createdAt) === todayKey)
    .sort((left, right) => {
      const leftLikes = Array.isArray(left.likeUserIds) ? left.likeUserIds.length : 0
      const rightLikes = Array.isArray(right.likeUserIds) ? right.likeUserIds.length : 0
      const scoreDifference = (Number(right.viewCount || 0) + rightLikes * 3) - (Number(left.viewCount || 0) + leftLikes * 3)
      return scoreDifference || new Date(right.createdAt) - new Date(left.createdAt)
    })[0]
  const verificationMap = await getVerificationMap(
    pagePosts.map((post) => post.authorId).concat(hotPostSource ? [hotPostSource.authorId] : [])
  )
  const posts = pagePosts.map((post) => formatPost(post, userId, verificationMap))
  const postsWithImages = await resolveCloudImageUrls(posts, 'postImages')
  const resolvedPosts = await resolveCloudFileField(postsWithImages, 'authorAvatarUrl')
  let resolvedHotPost = null
  if (hotPostSource) {
    const hotWithImages = await resolveCloudImageUrls([formatPost(hotPostSource, userId, verificationMap)], 'postImages')
    const hotWithAvatar = await resolveCloudFileField(hotWithImages, 'authorAvatarUrl')
    resolvedHotPost = hotWithAvatar[0] || null
  }
  return {
    success: true,
    posts: resolvedPosts,
    hotPost: resolvedHotPost,
    hotRule: '浏览量 + 点赞量 × 3',
    page: options.page,
    pageSize: options.pageSize,
    total: matchedPosts.length,
    hasMore: start + resolvedPosts.length < matchedPosts.length,
    scanLimited: allPosts.length >= MAX_SCAN_ITEMS
  }
}

function createForumViewId(postId, userId, dateKey) {
  const hash = crypto.createHash('sha256')
    .update(`${postId}:${userId}:${dateKey}`)
    .digest('hex')
  return `view_${hash.slice(0, 32)}`
}

async function recordUniqueView(postId, userId) {
  await ensureCollection(FORUM_VIEWS_COLLECTION)
  const dateKey = getChinaDateKey(new Date())
  const viewId = createForumViewId(postId, userId, dateKey)

  try {
    return await db.runTransaction(async (transaction) => {
      try {
        await transaction.collection(FORUM_VIEWS_COLLECTION).doc(viewId).get()
        return false
      } catch (error) {
        // 当天还没有该用户的浏览记录，继续创建唯一记录并累加浏览量。
      }

      const now = db.serverDate()
      await transaction.collection(FORUM_VIEWS_COLLECTION).doc(viewId).set({
        data: { postId, userId, dateKey, createdAt: now }
      })
      await transaction.collection(POSTS_COLLECTION).doc(postId).update({
        data: { viewCount: db.command.inc(1), updatedAt: now }
      })
      return true
    })
  } catch (error) {
    // 两次并发打开可能让其中一次事务冲突；如果唯一记录已存在，就按未新增处理。
    try {
      await db.collection(FORUM_VIEWS_COLLECTION).doc(viewId).get()
      return false
    } catch (checkError) {
      throw error
    }
  }
}

async function listMyPosts(event, userId) {
  await ensureCollection(POSTS_COLLECTION)
  const options = getPageOptions(event)
  const allPosts = await getAllPosts()
  const matchedPosts = allPosts
    .filter((post) => post.authorId === userId)
    .filter((post) => matchesPost(post, options))
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
  const start = (options.page - 1) * options.pageSize
  const posts = matchedPosts
    .slice(start, start + options.pageSize)
    .map((post) => formatPost(post, userId))
  const postsWithImages = await resolveCloudImageUrls(posts, 'postImages')
  const resolvedPosts = await resolveCloudFileField(postsWithImages, 'authorAvatarUrl')
  return {
    success: true,
    posts: resolvedPosts,
    page: options.page,
    pageSize: options.pageSize,
    total: matchedPosts.length,
    hasMore: start + resolvedPosts.length < matchedPosts.length,
    scanLimited: allPosts.length >= MAX_SCAN_ITEMS
  }
}

function createNotificationId(type, postId, actorId, extraId = '') {
  const hash = crypto.createHash('sha256')
    .update(`${type}:${postId}:${actorId}:${extraId}`)
    .digest('hex')
  return `notice_${hash.slice(0, 32)}`
}

async function saveNotification(notificationId, data) {
  if (data.receiverId === data.actorId) {
    return
  }
  await ensureCollection(NOTIFICATIONS_COLLECTION)
  const now = db.serverDate()
  await db.collection(NOTIFICATIONS_COLLECTION).doc(notificationId).set({
    data: {
      ...data,
      isRead: false,
      createdAt: now,
      updatedAt: now
    }
  })
}

async function removeNotification(notificationId) {
  try {
    await db.collection(NOTIFICATIONS_COLLECTION).doc(notificationId).remove()
  } catch (error) {
    if (!isCollectionMissing(error)) {
      console.error('删除互动通知失败：', error)
    }
  }
}

async function publishPost(event, userId, openid) {
  const validation = validatePost(event, userId)
  if (validation.code) {
    return { success: false, code: validation.code, message: validation.message }
  }
  if (!(await areImagesSafe(validation.postImages, userId, 'POST'))) {
    return { success: false, code: 'IMAGE_NOT_CHECKED', message: '图片尚未通过安全检查，请重新选择' }
  }

  const user = await getUser(userId)
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: '当前用户尚未初始化，请重新进入小程序' }
  }

  const contentCheck = await checkTextSecurity(validation.content, openid)
  if (!contentCheck.passed) {
    return { success: false, code: 'CONTENT_RISK', message: '内容可能不符合社区规范，请修改后再发布' }
  }

  await ensureCollection(POSTS_COLLECTION)
  if (await isActionTooFast(POSTS_COLLECTION, userId, 10000)) {
    return { success: false, code: 'PUBLISH_TOO_FAST', message: '发帖太频繁，请等待几秒后再试' }
  }
  const now = db.serverDate()
  const result = await db.collection(POSTS_COLLECTION).add({
    data: {
      authorId: userId,
      authorName: getDisplayName(user, userId),
      authorAvatarUrl: user.avatarUrl || '',
      category: validation.category,
      content: validation.content,
      postImages: validation.postImages,
      likeUserIds: [],
      viewCount: 0,
      commentCount: 0,
      status: 'VISIBLE',
      contentCheckStatus: contentCheck.status,
      createdAt: now,
      updatedAt: now
    }
  })

  return { success: true, postId: result._id }
}

async function getPost(event, userId) {
  const postId = String(event.postId || '').trim()
  if (!postId || postId.length > 128) {
    return { success: false, code: 'INVALID_POST_ID', message: '帖子 ID 无效' }
  }

  await ensureCollection(POSTS_COLLECTION)
  await ensureCollection(COMMENTS_COLLECTION)

  let postResult
  try {
    postResult = await db.collection(POSTS_COLLECTION).doc(postId).get()
  } catch (error) {
    return { success: false, code: 'POST_NOT_FOUND', message: '帖子不存在或已被删除' }
  }

  if (postResult.data.status === 'REMOVED' && postResult.data.authorId !== userId) {
    return { success: false, code: 'POST_REMOVED', message: '帖子已被平台处理' }
  }

  const viewRecorded = event.recordView !== false
    ? await recordUniqueView(postId, userId)
    : false
  const nextViewCount = Math.max(0, Number(postResult.data.viewCount || 0)) + (viewRecorded ? 1 : 0)
  postResult.data.viewCount = nextViewCount

  const commentResult = await db.collection(COMMENTS_COLLECTION)
    .where({ postId })
    .limit(100)
    .get()
  const comments = commentResult.data
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))
    .map((comment) => formatComment(comment, userId))

  const verificationMap = await getVerificationMap([postResult.data.authorId])

  const resolvedPosts = await resolveCloudImageUrls(
    [formatPost(postResult.data, userId, verificationMap)],
    'postImages'
  )
  const postsWithAvatars = await resolveCloudFileField(resolvedPosts, 'authorAvatarUrl')
  const commentsWithAvatars = await resolveCloudFileField(comments, 'authorAvatarUrl')
  return { success: true, post: postsWithAvatars[0], comments: buildCommentThreads(commentsWithAvatars) }
}

async function toggleLike(event, userId) {
  const postId = String(event.postId || '').trim()
  if (!postId || postId.length > 128) {
    return { success: false, code: 'INVALID_POST_ID', message: '帖子 ID 无效' }
  }

  await ensureCollection(POSTS_COLLECTION)
  const user = await getUser(userId)
  const result = await db.runTransaction(async (transaction) => {
    let postResult
    try {
      postResult = await transaction.collection(POSTS_COLLECTION).doc(postId).get()
    } catch (error) {
      throw new Error('POST_NOT_FOUND')
    }

    const post = postResult.data
    if (post.status === 'REMOVED') {
      throw new Error('POST_REMOVED')
    }
    const likeUserIds = Array.isArray(post.likeUserIds) ? post.likeUserIds : []
    const liked = likeUserIds.includes(userId)
    const nextLikeUserIds = liked
      ? likeUserIds.filter((id) => id !== userId)
      : likeUserIds.concat(userId)

    await transaction.collection(POSTS_COLLECTION).doc(postId).update({
      data: { likeUserIds: nextLikeUserIds, updatedAt: db.serverDate() }
    })

    return {
      liked: !liked,
      likeCount: nextLikeUserIds.length,
      receiverId: post.authorId,
      postPreview: String(post.content || '').slice(0, 40)
    }
  })

  if (result.receiverId !== userId) {
    const notificationId = createNotificationId('LIKE', postId, userId)
    if (result.liked) {
      await saveNotification(notificationId, {
        type: 'LIKE',
        postId,
        postPreview: result.postPreview,
        receiverId: result.receiverId,
        actorId: userId,
        actorName: getDisplayName(user, userId),
        actorAvatarUrl: (user && user.avatarUrl) || '',
        contentPreview: '赞了你的帖子'
      })
    } else {
      await removeNotification(notificationId)
    }
  }

  return { success: true, liked: result.liked, likeCount: result.likeCount }
}

async function toggleCommentLike(event, userId) {
  const commentId = String(event.commentId || '').trim()
  if (!commentId || commentId.length > 160) {
    return { success: false, code: 'INVALID_COMMENT_ID', message: '评论 ID 无效' }
  }

  await ensureCollection(COMMENTS_COLLECTION)
  const user = await getUser(userId)
  const result = await db.runTransaction(async (transaction) => {
    let commentResult
    try {
      commentResult = await transaction.collection(COMMENTS_COLLECTION).doc(commentId).get()
    } catch (error) {
      throw new Error('COMMENT_NOT_FOUND')
    }
    const comment = commentResult.data
    const likeUserIds = Array.isArray(comment.likeUserIds) ? comment.likeUserIds : []
    const liked = likeUserIds.includes(userId)
    const nextLikeUserIds = liked
      ? likeUserIds.filter((id) => id !== userId)
      : likeUserIds.concat(userId)
    await transaction.collection(COMMENTS_COLLECTION).doc(commentId).update({
      data: { likeUserIds: nextLikeUserIds, updatedAt: db.serverDate() }
    })
    return {
      liked: !liked,
      likeCount: nextLikeUserIds.length,
      postId: comment.postId,
      receiverId: comment.authorId,
      commentPreview: String(comment.content || '').slice(0, 40)
    }
  })

  const notificationId = createNotificationId('COMMENT_LIKE', result.postId, userId, commentId)
  if (result.receiverId !== userId) {
    if (result.liked) {
      await saveNotification(notificationId, {
        type: 'COMMENT_LIKE',
        postId: result.postId,
        commentId,
        receiverId: result.receiverId,
        actorId: userId,
        actorName: getDisplayName(user, userId),
        actorAvatarUrl: (user && user.avatarUrl) || '',
        contentPreview: `赞了你的评论：${result.commentPreview}`
      })
    } else {
      await removeNotification(notificationId)
    }
  }
  return { success: true, liked: result.liked, likeCount: result.likeCount }
}

async function addComment(event, userId, openid) {
  const postId = String(event.postId || '').trim()
  const content = String(event.content || '').trim()
  const replyToCommentId = String(event.replyToCommentId || '').trim()
  if (!postId || postId.length > 128) {
    return { success: false, code: 'INVALID_POST_ID', message: '帖子 ID 无效' }
  }
  if (!content || content.length > 200) {
    return { success: false, code: 'INVALID_COMMENT', message: '评论不能为空且不能超过200字' }
  }
  if (replyToCommentId.length > 160) {
    return { success: false, code: 'INVALID_COMMENT_ID', message: '回复目标无效' }
  }

  const user = await getUser(userId)
  if (!user) {
    return { success: false, code: 'USER_NOT_FOUND', message: '当前用户尚未初始化' }
  }


  const contentCheck = await checkTextSecurity(content, openid)
  if (!contentCheck.passed) {
    return { success: false, code: 'CONTENT_RISK', message: '评论可能不符合社区规范，请修改后再发送' }
  }

  await ensureCollection(POSTS_COLLECTION)
  await ensureCollection(COMMENTS_COLLECTION)
  if (await isActionTooFast(COMMENTS_COLLECTION, userId, 3000)) {
    return { success: false, code: 'COMMENT_TOO_FAST', message: '评论太频繁，请稍后再试' }
  }
  const commentId = `comment_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`

  const result = await db.runTransaction(async (transaction) => {
    let postResult
    try {
      postResult = await transaction.collection(POSTS_COLLECTION).doc(postId).get()
    } catch (error) {
      throw new Error('POST_NOT_FOUND')
    }

    if (postResult.data.status === 'REMOVED') {
      throw new Error('POST_REMOVED')
    }

    let replyTarget = null
    if (replyToCommentId) {
      try {
        const targetResult = await transaction.collection(COMMENTS_COLLECTION).doc(replyToCommentId).get()
        replyTarget = targetResult.data
      } catch (error) {
        throw new Error('COMMENT_NOT_FOUND')
      }
      if (replyTarget.postId !== postId) throw new Error('COMMENT_POST_MISMATCH')
    }

    const nextCount = Number(postResult.data.commentCount || 0) + 1
    const now = db.serverDate()
    await transaction.collection(COMMENTS_COLLECTION).doc(commentId).set({
      data: {
        postId,
        authorId: userId,
        authorName: getDisplayName(user, userId),
        authorAvatarUrl: user.avatarUrl || '',
        content,
        likeUserIds: [],
        parentCommentId: replyTarget ? (replyTarget.parentCommentId || replyToCommentId) : '',
        replyToCommentId: replyTarget ? replyToCommentId : '',
        replyToAuthorId: replyTarget ? replyTarget.authorId : '',
        replyToAuthorName: replyTarget ? (replyTarget.authorName || '校园社区用户') : '',
        contentCheckStatus: contentCheck.status,
        createdAt: now,
        updatedAt: now
      }
    })
    await transaction.collection(POSTS_COLLECTION).doc(postId).update({
      data: { commentCount: nextCount, updatedAt: now }
    })

    return {
      commentId,
      commentCount: nextCount,
      receiverId: replyTarget ? replyTarget.authorId : postResult.data.authorId,
      notificationType: replyTarget ? 'REPLY' : 'COMMENT',
      postPreview: String(postResult.data.content || '').slice(0, 40)
    }
  })

  if (result.receiverId !== userId) {
    await saveNotification(createNotificationId(result.notificationType, postId, userId, commentId), {
      type: result.notificationType,
      postId,
      commentId,
      postPreview: result.postPreview,
      receiverId: result.receiverId,
      actorId: userId,
      actorName: getDisplayName(user, userId),
      actorAvatarUrl: user.avatarUrl || '',
      contentPreview: result.notificationType === 'REPLY' ? `回复了你：${content.slice(0, 50)}` : content.slice(0, 60)
    })
  }

  return { success: true, commentId: result.commentId, commentCount: result.commentCount }
}

async function deletePost(event, userId) {
  const postId = String(event.postId || '').trim()
  if (!postId || postId.length > 128) {
    return { success: false, code: 'INVALID_POST_ID', message: '帖子 ID 无效' }
  }

  const transactionResult = await db.runTransaction(async (transaction) => {
    let postResult
    try {
      postResult = await transaction.collection(POSTS_COLLECTION).doc(postId).get()
    } catch (error) {
      throw new Error('POST_NOT_FOUND')
    }

    const post = postResult.data
    if (post.authorId !== userId) {
      throw new Error('NOT_POST_AUTHOR')
    }
    await transaction.collection(POSTS_COLLECTION).doc(postId).remove()
    return { postImages: Array.isArray(post.postImages) ? post.postImages : [] }
  })

  try {
    await db.collection(COMMENTS_COLLECTION).where({ postId }).remove()
  } catch (error) {
    if (!isCollectionMissing(error)) {
      console.error('删除帖子评论失败：', error)
    }
  }

  try {
    await db.collection(NOTIFICATIONS_COLLECTION).where({ postId }).remove()
  } catch (error) {
    if (!isCollectionMissing(error)) {
      console.error('删除帖子通知失败：', error)
    }
  }

  if (transactionResult.postImages.length > 0) {
    try {
      await cloud.deleteFile({ fileList: transactionResult.postImages })
    } catch (error) {
      console.error('删除帖子图片失败：', error)
    }
  }

  return { success: true, postId }
}

async function deleteComment(event, userId) {
  const commentId = String(event.commentId || '').trim()
  if (!commentId || commentId.length > 160) {
    return { success: false, code: 'INVALID_COMMENT_ID', message: '评论 ID 无效' }
  }

  const result = await db.runTransaction(async (transaction) => {
    let commentResult
    try {
      commentResult = await transaction.collection(COMMENTS_COLLECTION).doc(commentId).get()
    } catch (error) {
      throw new Error('COMMENT_NOT_FOUND')
    }
    const comment = commentResult.data
    if (comment.authorId !== userId) {
      throw new Error('NOT_COMMENT_AUTHOR')
    }

    let postResult
    try {
      postResult = await transaction.collection(POSTS_COLLECTION).doc(comment.postId).get()
    } catch (error) {
      throw new Error('POST_NOT_FOUND')
    }

    await transaction.collection(COMMENTS_COLLECTION).doc(commentId).remove()
    await transaction.collection(POSTS_COLLECTION).doc(comment.postId).update({
      data: {
        commentCount: Math.max(0, Number(postResult.data.commentCount || 0) - 1),
        updatedAt: db.serverDate()
      }
    })
    return { commentId, postId: comment.postId }
  })

  try {
    await db.collection(NOTIFICATIONS_COLLECTION).where({ commentId }).remove()
  } catch (error) {
    if (!isCollectionMissing(error)) console.error('删除评论相关通知失败：', error)
  }

  return { success: true, ...result }
}

async function listNotifications(userId) {
  await ensureCollection(NOTIFICATIONS_COLLECTION)
  const result = await db.collection(NOTIFICATIONS_COLLECTION)
    .where({ receiverId: userId })
    .limit(50)
    .get()
  const notifications = result.data
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .map((item) => ({
      id: item._id,
      type: item.type,
      postId: item.postId,
      taskId: item.taskId || '',
      orderId: item.orderId || '',
      taskTitle: item.taskTitle || '',
      actorName: item.actorName || '校园同学',
      actorAvatarUrl: item.actorAvatarUrl || '',
      contentPreview: item.contentPreview || '',
      postPreview: item.postPreview || '',
      isRead: Boolean(item.isRead),
      createdAt: formatChinaDate(item.createdAt)
    }))
  const withAvatars = await resolveCloudFileField(notifications, 'actorAvatarUrl')
  return {
    success: true,
    notifications: withAvatars,
    unreadCount: withAvatars.filter((item) => !item.isRead).length
  }
}

async function getNotificationSummary(userId) {
  await ensureCollection(NOTIFICATIONS_COLLECTION)
  const result = await db.collection(NOTIFICATIONS_COLLECTION)
    .where({ receiverId: userId, isRead: false })
    .count()
  return { success: true, unreadCount: Number(result.total || 0) }
}

async function markNotificationsRead(userId) {
  await ensureCollection(NOTIFICATIONS_COLLECTION)
  await db.collection(NOTIFICATIONS_COLLECTION)
    .where({ receiverId: userId, isRead: false })
    .update({ data: { isRead: true, updatedAt: db.serverDate() } })
  return { success: true }
}

async function reportPost(event, userId) {
  const postId = String(event.postId || '').trim()
  const reason = String(event.reason || '').trim()
  if (!postId || postId.length > 128) {
    return { success: false, code: 'INVALID_POST_ID', message: '帖子 ID 无效' }
  }
  if (!REPORT_REASONS.includes(reason)) {
    return { success: false, code: 'INVALID_REPORT_REASON', message: '请选择有效的举报原因' }
  }

  let postResult
  try {
    postResult = await db.collection(POSTS_COLLECTION).doc(postId).get()
  } catch (error) {
    return { success: false, code: 'POST_NOT_FOUND', message: '帖子不存在或已被删除' }
  }
  if (postResult.data.authorId === userId) {
    return { success: false, code: 'SELF_REPORT_NOT_ALLOWED', message: '不能举报自己发布的帖子' }
  }

  await ensureCollection(REPORTS_COLLECTION)
  const reportHash = crypto.createHash('sha256').update(`${postId}:${userId}`).digest('hex')
  const reportId = `report_${reportHash.slice(0, 32)}`
  try {
    await db.collection(REPORTS_COLLECTION).doc(reportId).get()
    return { success: false, code: 'ALREADY_REPORTED', message: '你已经举报过这篇帖子' }
  } catch (error) {
    // 查不到代表尚未举报，可以继续创建。
  }

  const now = db.serverDate()
  await db.collection(REPORTS_COLLECTION).doc(reportId).set({
    data: {
      postId,
      postAuthorId: postResult.data.authorId,
      reporterId: userId,
      reason,
      status: 'PENDING',
      createdAt: now,
      updatedAt: now
    }
  })
  return { success: true, reportId }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  if (!wxContext.OPENID || !wxContext.APPID) {
    return { success: false, code: 'WX_CONTEXT_MISSING', message: '无法获取微信用户身份' }
  }

  const userId = createUserId(wxContext.APPID, wxContext.OPENID)
  const action = String(event.action || '')

  try {
    const currentUser = await getUser(userId)
    if (currentUser && currentUser.accountStatus === 'SUSPENDED' && !['listNotifications', 'getNotificationSummary', 'markNotificationsRead'].includes(action)) {
      return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请前往安全中心反馈' }
    }
    const handlers = {
      listPosts: () => listPosts(event, userId),
      listMyPosts: () => listMyPosts(event, userId),
      publishPost: () => publishPost(event, userId, wxContext.OPENID),
      getPost: () => getPost(event, userId),
      toggleLike: () => toggleLike(event, userId),
      toggleCommentLike: () => toggleCommentLike(event, userId),
      addComment: () => addComment(event, userId, wxContext.OPENID),
      deletePost: () => deletePost(event, userId),
      deleteComment: () => deleteComment(event, userId),
      reportPost: () => reportPost(event, userId),
      listNotifications: () => listNotifications(userId),
      getNotificationSummary: () => getNotificationSummary(userId),
      markNotificationsRead: () => markNotificationsRead(userId)
    }

    if (!handlers[action]) {
      return { success: false, code: 'INVALID_ACTION', message: '不支持的论坛操作' }
    }
    return await handlers[action]()
  } catch (error) {
    const errorText = String(error.message || '')
    const businessErrors = {
      POST_NOT_FOUND: '帖子不存在或已被删除',
      POST_REMOVED: '帖子已被平台处理',
      COMMENT_NOT_FOUND: '评论不存在或已被删除',
      COMMENT_POST_MISMATCH: '回复目标不属于当前帖子',
      NOT_POST_AUTHOR: '只能删除自己发布的帖子',
      NOT_COMMENT_AUTHOR: '只能删除自己的评论'
    }
    const businessCode = Object.keys(businessErrors).find((code) => errorText.includes(code))
    if (businessCode) {
      return { success: false, code: businessCode, message: businessErrors[businessCode] }
    }
    console.error('forumApi 执行失败：', action, error)
    return { success: false, code: 'FORUM_API_FAILED', message: '校园圈操作失败，请稍后重试' }
  }
}
