const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const TASKS_COLLECTION = 'tasks'
const ORDERS_COLLECTION = 'orders'

function createUserId(appid, openid) {
  const source = `${appid}:${openid}`
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function isCollectionMissing(error) {
  const errorText = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(errorText)
}

function isCollectionExists(error) {
  const errorText = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(already exist|已存在)|DATABASE_COLLECTION_EXIST/i.test(errorText)
}

function getBusinessCode(error) {
  const errorText = `${error && error.message} ${error && error.errMsg}`
  const codes = [
    'TASK_NOT_FOUND',
    'SELF_ACCEPT_NOT_ALLOWED',
    'TASK_ALREADY_ACCEPTED',
    'TASK_WAITING_CONFIRM',
    'TASK_ALREADY_COMPLETED',
    'TASK_CANCELLED',
    'TASK_EXPIRED'
  ]

  return codes.find((code) => errorText.includes(code)) || ''
}

function getBusinessMessage(code) {
  const messages = {
    TASK_NOT_FOUND: '任务不存在',
    SELF_ACCEPT_NOT_ALLOWED: '不能接取自己发布的任务',
    TASK_ALREADY_ACCEPTED: '任务已经被其他同学接取',
    TASK_WAITING_CONFIRM: '任务正在等待发布者确认',
    TASK_ALREADY_COMPLETED: '任务已经完成',
    TASK_CANCELLED: '任务已被发布者取消',
    TASK_EXPIRED: '任务已经超过截止时间'
  }

  return messages[code] || '接单失败，请稍后重试'
}

async function ensureOrdersCollection() {
  try {
    await db.collection(ORDERS_COLLECTION).limit(1).get()
  } catch (error) {
    if (!isCollectionMissing(error) || typeof db.createCollection !== 'function') {
      throw error
    }

    try {
      await db.createCollection(ORDERS_COLLECTION)
    } catch (createError) {
      // 两个用户第一次同时接单时，可能同时尝试创建集合；已存在即可继续。
      if (!isCollectionExists(createError)) {
        throw createError
      }
    }
  }
}

async function createNotification(data) {
  try {
    const now = db.serverDate()
    const result = await db.collection('notifications').add({ data: { ...data, actorName: '任务进度', actorAvatarUrl: '', isRead: false, serviceStatus: 'PENDING', createdAt: now, updatedAt: now } })
    try { await cloud.callFunction({ name: 'serviceNotification', data: { notificationId: result._id } }) } catch (sendError) { console.error('触发服务通知失败：', sendError) }
  } catch (error) { console.error('创建接单通知失败：', error) }
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

  if (typeof db.runTransaction !== 'function') {
    return {
      success: false,
      code: 'TRANSACTION_UNAVAILABLE',
      message: '当前云数据库 SDK 不支持事务，请联系开发者'
    }
  }

  const workerId = createUserId(appid, openid)
  const orderId = `order_${taskId}`

  try {
    const userResult = await db.collection('users').doc(workerId).get()
    if (userResult.data.accountStatus === 'SUSPENDED') {
      return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请联系客服' }
    }
    await ensureOrdersCollection()

    const transactionResult = await db.runTransaction(async (transaction) => {
      let taskResult

      try {
        taskResult = await transaction
          .collection(TASKS_COLLECTION)
          .doc(taskId)
          .get()
      } catch (error) {
        throw new Error('TASK_NOT_FOUND')
      }

      const task = taskResult.data

      if (!task) {
        throw new Error('TASK_NOT_FOUND')
      }

      if (task.publisherId === workerId) {
        throw new Error('SELF_ACCEPT_NOT_ALLOWED')
      }

      if (task.deadline && new Date(task.deadline).getTime() < Date.now()) {
        throw new Error('TASK_EXPIRED')
      }

      if (task.status !== 'WAITING') {
        const statusCodes = {
          ACCEPTED: 'TASK_ALREADY_ACCEPTED',
          WAITING_CONFIRM: 'TASK_WAITING_CONFIRM',
          COMPLETED: 'TASK_ALREADY_COMPLETED',
          CANCELLED: 'TASK_CANCELLED',
          EXPIRED: 'TASK_EXPIRED'
        }
        throw new Error(statusCodes[task.status] || 'TASK_ALREADY_ACCEPTED')
      }

      const now = db.serverDate()

      await transaction.collection(TASKS_COLLECTION).doc(taskId).update({
        data: {
          status: 'ACCEPTED',
          workerId,
          acceptedAt: now,
          updatedAt: now
        }
      })

      await transaction.collection(ORDERS_COLLECTION).doc(orderId).set({
        data: {
          taskId,
          publisherId: task.publisherId,
          workerId,
          title: task.title,
          category: task.category,
          description: task.description,
          reward: task.reward,
          location: task.location,
          deadline: task.deadline,
          status: 'ACCEPTED',
          createdAt: now,
          acceptedAt: now,
          submittedAt: null,
          completedAt: null,
          updatedAt: now
        }
      })

      return {
        orderId,
        taskId,
        status: 'ACCEPTED',
        receiverId: task.publisherId,
        title: task.title
      }
    })

    await createNotification({ type: 'TASK_ACCEPTED', receiverId: transactionResult.receiverId, actorId: workerId, taskId, orderId, taskTitle: transactionResult.title, contentPreview: '你的任务已被同学接单' })

    return {
      success: true,
      order: transactionResult
    }
  } catch (error) {
    const businessCode = getBusinessCode(error)

    if (businessCode) {
      return {
        success: false,
        code: businessCode,
        message: getBusinessMessage(businessCode)
      }
    }

    console.error('云端事务接单失败：', error)
    return {
      success: false,
      code: 'ACCEPT_TASK_FAILED',
      message: '接单失败，请稍后重试'
    }
  }
}
