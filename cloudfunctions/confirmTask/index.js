const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

function createUserId(appid, openid) {
  const source = `${appid}:${openid}`
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function getBusinessCode(error) {
  const errorText = `${error && error.message} ${error && error.errMsg}`
  const codes = [
    'TASK_NOT_FOUND',
    'ORDER_NOT_FOUND',
    'NOT_TASK_PUBLISHER',
    'TASK_ALREADY_COMPLETED',
    'INVALID_TASK_STATUS',
    'ORDER_STATUS_CONFLICT'
  ]

  return codes.find((code) => errorText.includes(code)) || ''
}

function getBusinessMessage(code) {
  const messages = {
    TASK_NOT_FOUND: '任务不存在',
    ORDER_NOT_FOUND: '没有找到对应订单',
    NOT_TASK_PUBLISHER: '只有任务发布者可以确认完成',
    TASK_ALREADY_COMPLETED: '任务已经完成',
    INVALID_TASK_STATUS: '任务还没有进入待确认状态',
    ORDER_STATUS_CONFLICT: '订单状态与任务不一致，请稍后重试'
  }

  return messages[code] || '确认完成失败，请稍后重试'
}

async function createNotification(data) {
  try {
    const now = db.serverDate()
    const result = await db.collection('notifications').add({ data: { ...data, actorName: '任务进度', actorAvatarUrl: '', isRead: false, serviceStatus: 'PENDING', createdAt: now, updatedAt: now } })
    try { await cloud.callFunction({ name: 'serviceNotification', data: { notificationId: result._id } }) } catch (sendError) { console.error('触发服务通知失败：', sendError) }
  } catch (error) { console.error('创建确认完成通知失败：', error) }
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
      message: '当前云数据库 SDK 不支持事务'
    }
  }

  const publisherId = createUserId(appid, openid)

  try {
    const userResult = await db.collection('users').doc(publisherId).get()
    if (userResult.data.accountStatus === 'SUSPENDED') {
      return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请联系客服' }
    }
  } catch (error) {
    return { success: false, code: 'USER_NOT_FOUND', message: '用户尚未初始化' }
  }
  const orderId = `order_${taskId}`

  try {
    const transactionResult = await db.runTransaction(async (transaction) => {
      let taskResult

      try {
        taskResult = await transaction.collection('tasks').doc(taskId).get()
      } catch (error) {
        throw new Error('TASK_NOT_FOUND')
      }

      const task = taskResult.data

      if (!task) {
        throw new Error('TASK_NOT_FOUND')
      }

      if (task.publisherId !== publisherId) {
        throw new Error('NOT_TASK_PUBLISHER')
      }

      if (task.status !== 'WAITING_CONFIRM') {
        throw new Error(
          task.status === 'COMPLETED'
            ? 'TASK_ALREADY_COMPLETED'
            : 'INVALID_TASK_STATUS'
        )
      }

      let orderResult

      try {
        orderResult = await transaction.collection('orders').doc(orderId).get()
      } catch (error) {
        throw new Error('ORDER_NOT_FOUND')
      }

      const order = orderResult.data

      if (
        !order ||
        order.taskId !== taskId ||
        order.publisherId !== publisherId ||
        order.status !== 'WAITING_CONFIRM'
      ) {
        throw new Error('ORDER_STATUS_CONFLICT')
      }

      const now = db.serverDate()

      await transaction.collection('tasks').doc(taskId).update({
        data: {
          status: 'COMPLETED',
          completedAt: now,
          updatedAt: now
        }
      })

      await transaction.collection('orders').doc(orderId).update({
        data: {
          status: 'COMPLETED',
          completedAt: now,
          updatedAt: now
        }
      })

      return {
        orderId,
        taskId,
        status: 'COMPLETED',
        receiverId: order.workerId,
        title: order.title
      }
    })

    await createNotification({ type: 'TASK_COMPLETED', receiverId: transactionResult.receiverId, actorId: publisherId, taskId, orderId, taskTitle: transactionResult.title, contentPreview: '发布者已确认完成，订单流程结束' })

    return {
      success: true,
      result: transactionResult
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

    console.error('发布者确认完成事务失败：', error)
    return {
      success: false,
      code: 'CONFIRM_TASK_FAILED',
      message: '确认完成失败，请稍后重试'
    }
  }
}
