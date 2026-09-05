const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const DEFAULT_PAGE_SIZE = 12
const MAX_PAGE_SIZE = 50
const SCAN_BATCH_SIZE = 100
const MAX_SCAN_ITEMS = 1000

function createUserId(appid, openid) {
  return `user_${crypto.createHash('sha256').update(`${appid}:${openid}`).digest('hex').slice(0, 24)}`
}

function isCollectionMissing(error) {
  const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(text)
}

function formatChinaDate(value, includeTime = false) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const chinaDate = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const dateText = `${chinaDate.getUTCFullYear()}-${String(chinaDate.getUTCMonth() + 1).padStart(2, '0')}-${String(chinaDate.getUTCDate()).padStart(2, '0')}`
  return includeTime ? `${dateText} ${String(chinaDate.getUTCHours()).padStart(2, '0')}:${String(chinaDate.getUTCMinutes()).padStart(2, '0')}` : dateText
}

function getTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 0 : date.getTime()
}

function getOptions(event = {}) {
  return {
    page: Math.max(1, Number.parseInt(event.page, 10) || 1),
    pageSize: Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(event.pageSize, 10) || DEFAULT_PAGE_SIZE)),
    keyword: String(event.keyword || '').trim().toLowerCase().slice(0, 50)
  }
}

async function scanByUser(collectionName, fieldName, userId) {
  const items = []
  for (let offset = 0; offset < MAX_SCAN_ITEMS; offset += SCAN_BATCH_SIZE) {
    const result = await db.collection(collectionName).where({ [fieldName]: userId }).skip(offset).limit(SCAN_BATCH_SIZE).get()
    items.push(...result.data)
    if (result.data.length < SCAN_BATCH_SIZE) break
  }
  return items
}

function matchesKeyword(item, keyword) {
  if (!keyword) return true
  return [item.title, item.category, item.description, item.location, item.status]
    .filter(Boolean).join(' ').toLowerCase().includes(keyword)
}

async function resolveCloudImageUrls(items) {
  const ids = Array.from(new Set(items.flatMap((item) => Array.isArray(item.proofImages) ? item.proofImages : [])
    .filter((id) => typeof id === 'string' && id.startsWith('cloud://'))))
  if (!ids.length) return items
  const result = await cloud.getTempFileURL({ fileList: ids })
  const map = new Map((result.fileList || []).filter((file) => file.tempFileURL).map((file) => [file.fileID, file.tempFileURL]))
  return items.map((item) => ({ ...item, proofImages: (item.proofImages || []).map((id) => map.get(id) || id) }))
}

function formatOrder(order) {
  return {
    id: order._id, taskId: order.taskId, title: order.title, category: order.category,
    description: order.description, reward: order.reward, location: order.location,
    deadline: formatChinaDate(order.deadline, true), status: order.status, proofText: order.proofText || '',
    proofImages: Array.isArray(order.proofImages) ? order.proofImages : [],
    createdAt: formatChinaDate(order.createdAt, true), acceptedAt: formatChinaDate(order.acceptedAt, true),
    submittedAt: formatChinaDate(order.submittedAt, true), completedAt: formatChinaDate(order.completedAt, true)
  }
}

function formatTask(task, expiredIds) {
  return {
    id: task._id, title: task.title, category: task.category, description: task.description,
    reward: task.reward, location: task.location, deadline: formatChinaDate(task.deadline, true),
    status: expiredIds.has(task._id) ? 'EXPIRED' : task.status, proofText: task.proofText || '',
    proofImages: Array.isArray(task.proofImages) ? task.proofImages : [],
    createdAt: formatChinaDate(task.createdAt, true), updatedAt: formatChinaDate(task.updatedAt, true)
  }
}

async function safeScanByUser(collectionName, fieldName, userId) {
  try {
    return await scanByUser(collectionName, fieldName, userId)
  } catch (error) {
    if (isCollectionMissing(error)) return []
    throw error
  }
}

function formatHomeProgress(item, role) {
  const completedByStatus = { ACCEPTED: 2, WAITING_CONFIRM: 3, COMPLETED: 4 }
  const completed = completedByStatus[item.status] || 1
  const labels = ['发布', '接单', '提交', '完成']
  const statusText = {
    ACCEPTED: '进行中',
    WAITING_CONFIRM: '待确认',
    COMPLETED: '已完成'
  }[item.status] || item.status
  const actionText = item.status === 'WAITING_CONFIRM' && role === 'PUBLISHER'
    ? '去确认'
    : item.status === 'ACCEPTED' && role === 'WORKER'
      ? '去提交'
      : '查看详情'

  return {
    id: role === 'PUBLISHER' ? item._id : item.taskId,
    sourceId: item._id,
    title: item.title,
    status: item.status,
    statusText,
    role,
    roleText: role === 'PUBLISHER' ? '我发布的' : '我接的',
    actionText,
    updatedTime: getTime(item.updatedAt || item.completedAt || item.submittedAt || item.acceptedAt || item.createdAt),
    progressSteps: labels.map((label, index) => ({
      label,
      done: index < completed,
      current: completed < labels.length && index === completed,
      lineDone: index + 1 < completed
    }))
  }
}

async function getHomeProgress(userId) {
  const [publishedTasks, acceptedOrders] = await Promise.all([
    safeScanByUser('tasks', 'publisherId', userId),
    safeScanByUser('orders', 'workerId', userId)
  ])
  const visibleStatuses = new Set(['ACCEPTED', 'WAITING_CONFIRM', 'COMPLETED'])
  const items = publishedTasks
    .filter((task) => visibleStatuses.has(task.status))
    .filter((task) => task.status !== 'COMPLETED' || !task.homeProgressSeenPublisher)
    .map((task) => formatHomeProgress(task, 'PUBLISHER'))
    .concat(acceptedOrders
      .filter((order) => visibleStatuses.has(order.status))
      .filter((order) => order.status !== 'COMPLETED' || !order.homeProgressSeenWorker)
      .map((order) => formatHomeProgress(order, 'WORKER')))

  const priority = { WAITING_CONFIRM: 3, ACCEPTED: 2, COMPLETED: 1 }
  items.sort((left, right) => (
    (priority[right.status] || 0) - (priority[left.status] || 0) || right.updatedTime - left.updatedTime
  ))
  return { success: true, item: items[0] || null, total: items.length }
}

async function markHomeProgressSeen(event, userId) {
  const role = String(event.role || '')
  const sourceId = String(event.sourceId || '').trim()
  if (!sourceId || !['PUBLISHER', 'WORKER'].includes(role)) {
    return { success: false, code: 'INVALID_PROGRESS_ITEM', message: '任务进度记录无效' }
  }
  const collectionName = role === 'PUBLISHER' ? 'tasks' : 'orders'
  const ownerField = role === 'PUBLISHER' ? 'publisherId' : 'workerId'
  const seenField = role === 'PUBLISHER' ? 'homeProgressSeenPublisher' : 'homeProgressSeenWorker'
  try {
    const result = await db.collection(collectionName).doc(sourceId).get()
    if (result.data[ownerField] !== userId) {
      return { success: false, code: 'NOT_PROGRESS_OWNER', message: '无权操作该任务进度' }
    }
    if (result.data.status !== 'COMPLETED') {
      return { success: true, marked: false }
    }
    await db.collection(collectionName).doc(sourceId).update({
      data: { [seenField]: true, updatedAt: db.serverDate() }
    })
    return { success: true, marked: true }
  } catch (error) {
    console.error('标记首页任务进度失败：', error)
    return { success: false, code: 'MARK_PROGRESS_FAILED', message: '任务进度状态保存失败' }
  }
}

exports.main = async (event = {}) => {
  const type = String(event.type || '')
  if (!['orders', 'published', 'home', 'markHomeProgressSeen'].includes(type)) return { success: false, code: 'INVALID_DATA_TYPE', message: '请求的数据类型无效' }
  const context = cloud.getWXContext()
  if (!context.OPENID || !context.APPID) return { success: false, code: 'WX_CONTEXT_MISSING', message: '无法获取微信用户身份' }
  const userId = createUserId(context.APPID, context.OPENID)
  if (type === 'home') return getHomeProgress(userId)
  if (type === 'markHomeProgressSeen') return markHomeProgressSeen(event, userId)
  const options = getOptions(event)

  try {
    const isOrders = type === 'orders'
    const allItems = await scanByUser(isOrders ? 'orders' : 'tasks', isOrders ? 'workerId' : 'publisherId', userId)
    const expiredIds = new Set()
    if (!isOrders) {
      const expired = allItems.filter((task) => task.status === 'WAITING' && task.deadline && getTime(task.deadline) < Date.now())
      await Promise.all(expired.map((task) => db.collection('tasks').doc(task._id).update({
        data: { status: 'EXPIRED', expiredAt: db.serverDate(), updatedAt: db.serverDate() }
      })))
      expired.forEach((task) => expiredIds.add(task._id))
    }

    const matchedItems = allItems.filter((item) => matchesKeyword(item, options.keyword))
      .sort((left, right) => getTime(isOrders ? right.acceptedAt : right.createdAt) - getTime(isOrders ? left.acceptedAt : left.createdAt))
    const start = (options.page - 1) * options.pageSize
    const rawPage = matchedItems.slice(start, start + options.pageSize)
      .map((item) => isOrders ? formatOrder(item) : formatTask(item, expiredIds))
    const items = await resolveCloudImageUrls(rawPage)

    return {
      success: true, type, items, page: options.page, pageSize: options.pageSize,
      total: matchedItems.length, hasMore: start + items.length < matchedItems.length,
      scanLimited: allItems.length >= MAX_SCAN_ITEMS
    }
  } catch (error) {
    if (isCollectionMissing(error)) {
      return { success: true, type, items: [], page: options.page, pageSize: options.pageSize, total: 0, hasMore: false }
    }
    console.error('读取我的云端任务数据失败：', error)
    return { success: false, code: 'MY_TASK_DATA_FAILED', message: '读取云端记录失败' }
  }
}
