const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const TASKS_COLLECTION = 'tasks'
const USERS_COLLECTION = 'users'
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50
const SCAN_BATCH_SIZE = 100
const MAX_SCAN_ITEMS = 1000

function isCollectionMissing(error) {
  const errorText = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(errorText)
}

function getPageOptions(event = {}) {
  const page = Math.max(1, Number.parseInt(event.page, 10) || 1)
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(event.pageSize, 10) || DEFAULT_PAGE_SIZE))
  return {
    page,
    pageSize,
    keyword: String(event.keyword || '').trim().toLowerCase().slice(0, 50),
    filter: String(event.filter || 'ALL').trim()
  }
}

async function getAllTasks() {
  const items = []
  for (let offset = 0; offset < MAX_SCAN_ITEMS; offset += SCAN_BATCH_SIZE) {
    const result = await db.collection(TASKS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .skip(offset)
      .limit(SCAN_BATCH_SIZE)
      .get()
    items.push(...result.data)
    if (result.data.length < SCAN_BATCH_SIZE) break
  }
  return items
}

async function getVerificationMap(userIds) {
  const uniqueUserIds = Array.from(new Set((userIds || []).filter(Boolean)))
  const entries = await Promise.all(uniqueUserIds.map(async (userId) => {
    try {
      const result = await db.collection(USERS_COLLECTION).doc(userId).get()
      return [userId, result.data.campusVerificationStatus || 'UNVERIFIED']
    } catch (error) {
      return [userId, 'UNVERIFIED']
    }
  }))
  return new Map(entries)
}

function formatChinaDate(value, includeTime = false) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const chinaDate = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const year = chinaDate.getUTCFullYear()
  const month = String(chinaDate.getUTCMonth() + 1).padStart(2, '0')
  const day = String(chinaDate.getUTCDate()).padStart(2, '0')
  if (!includeTime) return `${year}-${month}-${day}`
  const hours = String(chinaDate.getUTCHours()).padStart(2, '0')
  const minutes = String(chinaDate.getUTCMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function matchesTask(task, options) {
  if (options.filter === 'WAITING' && task.status !== 'WAITING') return false
  if (!['ALL', 'WAITING'].includes(options.filter) && task.category !== options.filter) return false
  if (!options.keyword) return true
  return [task.title, task.description, task.location, task.category]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .includes(options.keyword)
}

exports.main = async (event = {}) => {
  const options = getPageOptions(event)
  try {
    let rawTasks
    try {
      rawTasks = await getAllTasks()
    } catch (error) {
      if (!isCollectionMissing(error) || typeof db.createCollection !== 'function') throw error
      await db.createCollection(TASKS_COLLECTION)
      rawTasks = []
    }

    const nowTime = Date.now()
    const expiredTasks = rawTasks.filter((task) => (
      task.status === 'WAITING' && task.deadline && new Date(task.deadline).getTime() < nowTime
    ))
    await Promise.all(expiredTasks.map((task) => db.collection(TASKS_COLLECTION).doc(task._id).update({
      data: { status: 'EXPIRED', expiredAt: db.serverDate(), updatedAt: db.serverDate() }
    })))
    const expiredIds = new Set(expiredTasks.map((task) => task._id))
    const normalizedTasks = rawTasks.map((task) => ({
      ...task,
      status: expiredIds.has(task._id) ? 'EXPIRED' : task.status
    }))
    const matchedTasks = normalizedTasks.filter((task) => matchesTask(task, options))
    const start = (options.page - 1) * options.pageSize
    const pageTasks = matchedTasks.slice(start, start + options.pageSize)
    const verificationMap = await getVerificationMap(pageTasks.map((task) => task.publisherId))
    const tasks = pageTasks.map((task) => ({
      id: task._id,
      publisherId: task.publisherId,
      isAnonymous: task.isAnonymous === true,
      isPublisherVerified: verificationMap.get(task.publisherId) === 'VERIFIED',
      title: task.title,
      category: task.category,
      description: task.description,
      reward: task.reward,
      location: task.location,
      deadline: formatChinaDate(task.deadline, true),
      status: task.status,
      createdAt: formatChinaDate(task.createdAt, true),
      updatedAt: formatChinaDate(task.updatedAt, true)
    }))

    return {
      success: true,
      tasks,
      page: options.page,
      pageSize: options.pageSize,
      total: matchedTasks.length,
      hasMore: start + tasks.length < matchedTasks.length,
      scanLimited: rawTasks.length >= MAX_SCAN_ITEMS
    }
  } catch (error) {
    console.error('读取任务列表失败：', error)
    return {
      success: false,
      code: isCollectionMissing(error) ? 'TASKS_COLLECTION_MISSING' : 'TASK_LIST_FAILED',
      message: isCollectionMissing(error) ? 'tasks 集合尚未创建' : '读取任务列表失败'
    }
  }
}
