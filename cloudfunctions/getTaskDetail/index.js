const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const TASKS_COLLECTION = 'tasks'
const USERS_COLLECTION = 'users'

function createUserId(appid, openid) {
  const source = `${appid}:${openid}`
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function formatChinaDate(value, includeTime = false) {
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

  if (!includeTime) {
    return `${year}-${month}-${day}`
  }

  const hours = String(chinaDate.getUTCHours()).padStart(2, '0')
  const minutes = String(chinaDate.getUTCMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function isDocumentMissing(error) {
  const errorText = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /document.*(not exist|不存在)|DATABASE_DOCUMENT_NOT_EXIST|(^|\s)-1(\s|$)/i.test(errorText)
}

exports.main = async (event) => {
  const taskId = String((event && event.taskId) || '').trim()

  if (!taskId || taskId.length > 128) {
    return {
      success: false,
      code: 'INVALID_TASK_ID',
      message: '任务 ID 无效'
    }
  }

  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const appid = wxContext.APPID

  if (!openid || !appid) {
    return {
      success: false,
      code: 'WX_CONTEXT_MISSING',
      message: '无法获取微信用户身份'
    }
  }

  try {
    const result = await db.collection(TASKS_COLLECTION).doc(taskId).get()
    const task = result.data
    if (task.status === 'WAITING' && task.deadline && new Date(task.deadline).getTime() < Date.now()) {
      await db.collection(TASKS_COLLECTION).doc(taskId).update({
        data: { status: 'EXPIRED', expiredAt: db.serverDate(), updatedAt: db.serverDate() }
      })
      task.status = 'EXPIRED'
    }
    const currentUserId = createUserId(appid, openid)
    let isPublisherVerified = false
    try {
      const publisherResult = await db.collection(USERS_COLLECTION).doc(task.publisherId).get()
      isPublisherVerified = publisherResult.data.campusVerificationStatus === 'VERIFIED'
    } catch (error) {
      isPublisherVerified = false
    }

    return {
      success: true,
      task: {
        id: task._id,
        publisherId: task.publisherId,
        isAnonymous: task.isAnonymous === true,
        isPublisherVerified,
        title: task.title,
        category: task.category,
        description: task.description,
        reward: task.reward,
        location: task.location,
        deadline: formatChinaDate(task.deadline, true),
        status: task.status,
        createdAt: formatChinaDate(task.createdAt, true),
        updatedAt: formatChinaDate(task.updatedAt, true),
        isPublisher: task.publisherId === currentUserId
      }
    }
  } catch (error) {
    console.error('读取云端任务详情失败：', error)
    return {
      success: false,
      code: isDocumentMissing(error) ? 'TASK_NOT_FOUND' : 'TASK_DETAIL_FAILED',
      message: isDocumentMissing(error) ? '任务不存在' : '读取任务详情失败'
    }
  }
}
