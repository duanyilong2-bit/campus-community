const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()

function createImageCheckId(fileId) {
  return `image_${crypto.createHash('sha256').update(fileId).digest('hex').slice(0, 32)}`
}

async function areProofImagesSafe(fileIds, userId, orderId) {
  for (const fileId of fileIds) {
    try {
      const result = await db.collection('image_security_checks').doc(createImageCheckId(fileId)).get()
      const check = result.data
      if (!check || check.fileId !== fileId || check.userId !== userId || check.purpose !== 'TASK_PROOF' || check.relatedId !== orderId || check.result !== 'PASS') return false
    } catch (error) { return false }
  }
  return true
}

function createUserId(appid, openid) {
  const source = `${appid}:${openid}`
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function getBusinessCode(error) {
  const errorText = `${error && error.message} ${error && error.errMsg}`
  const codes = [
    'ORDER_NOT_FOUND',
    'TASK_NOT_FOUND',
    'NOT_ORDER_WORKER',
    'ORDER_ALREADY_SUBMITTED',
    'ORDER_ALREADY_COMPLETED',
    'INVALID_ORDER_STATUS',
    'TASK_STATUS_CONFLICT'
  ]

  return codes.find((code) => errorText.includes(code)) || ''
}

function getBusinessMessage(code) {
  const messages = {
    ORDER_NOT_FOUND: '订单不存在',
    TASK_NOT_FOUND: '对应任务不存在',
    NOT_ORDER_WORKER: '只有接单者可以提交完成',
    ORDER_ALREADY_SUBMITTED: '任务已经提交，正在等待发布者确认',
    ORDER_ALREADY_COMPLETED: '订单已经完成',
    INVALID_ORDER_STATUS: '当前订单状态不能提交完成',
    TASK_STATUS_CONFLICT: '任务状态与订单不一致，请稍后重试'
  }

  return messages[code] || '提交完成失败，请稍后重试'
}

async function createNotification(data) {
  try {
    const now = db.serverDate()
    const result = await db.collection('notifications').add({ data: { ...data, actorName: '任务进度', actorAvatarUrl: '', isRead: false, serviceStatus: 'PENDING', createdAt: now, updatedAt: now } })
    try { await cloud.callFunction({ name: 'serviceNotification', data: { notificationId: result._id } }) } catch (sendError) { console.error('触发服务通知失败：', sendError) }
  } catch (error) { console.error('创建提交完成通知失败：', error) }
}

exports.main = async (event) => {
  const orderId = String((event && event.orderId) || '').trim()
  const proofText = String((event && event.proofText) || '').trim()
  const proofImages = Array.isArray(event && event.proofImages)
    ? event.proofImages
    : []

  if (!orderId || orderId.length > 160) {
    return {
      success: false,
      code: 'INVALID_ORDER_ID',
      message: '订单 ID 无效'
    }
  }

  if (proofText.length > 500) {
    return {
      success: false,
      code: 'PROOF_TEXT_TOO_LONG',
      message: '文字说明不能超过500字'
    }
  }

  if (proofImages.length > 3) {
    return {
      success: false,
      code: 'TOO_MANY_PROOF_IMAGES',
      message: '最多只能提交3张图片'
    }
  }

  if (!proofText && proofImages.length === 0) {
    return {
      success: false,
      code: 'PROOF_REQUIRED',
      message: '请填写文字说明或上传图片'
    }
  }

  const expectedPath = `/task-proofs/${orderId}/`
  const hasInvalidImage = proofImages.some((fileId) => (
    typeof fileId !== 'string' ||
    fileId.length > 1024 ||
    !fileId.startsWith('cloud://') ||
    !fileId.includes(expectedPath)
  ))

  if (hasInvalidImage) {
    return {
      success: false,
      code: 'INVALID_PROOF_IMAGE',
      message: '图片凭证无效，请重新上传'
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

  const workerId = createUserId(appid, openid)

  if (!(await areProofImagesSafe(proofImages, workerId, orderId))) {
    return { success: false, code: 'IMAGE_NOT_CHECKED', message: '完成凭证图片尚未通过安全检查' }
  }

  try {
    const userResult = await db.collection('users').doc(workerId).get()
    if (userResult.data.accountStatus === 'SUSPENDED') {
      return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请联系客服' }
    }
  } catch (error) {
    return { success: false, code: 'USER_NOT_FOUND', message: '用户尚未初始化' }
  }

  try {
    const transactionResult = await db.runTransaction(async (transaction) => {
      let orderResult

      try {
        orderResult = await transaction.collection('orders').doc(orderId).get()
      } catch (error) {
        throw new Error('ORDER_NOT_FOUND')
      }

      const order = orderResult.data

      if (!order) {
        throw new Error('ORDER_NOT_FOUND')
      }

      if (order.workerId !== workerId) {
        throw new Error('NOT_ORDER_WORKER')
      }

      if (order.status !== 'ACCEPTED') {
        const statusCode = order.status === 'WAITING_CONFIRM'
          ? 'ORDER_ALREADY_SUBMITTED'
          : order.status === 'COMPLETED'
            ? 'ORDER_ALREADY_COMPLETED'
            : 'INVALID_ORDER_STATUS'
        throw new Error(statusCode)
      }

      let taskResult

      try {
        taskResult = await transaction.collection('tasks').doc(order.taskId).get()
      } catch (error) {
        throw new Error('TASK_NOT_FOUND')
      }

      const task = taskResult.data

      if (!task) {
        throw new Error('TASK_NOT_FOUND')
      }

      if (task.status !== 'ACCEPTED' || task.workerId !== workerId) {
        throw new Error('TASK_STATUS_CONFLICT')
      }

      const now = db.serverDate()

      await transaction.collection('orders').doc(orderId).update({
        data: {
          status: 'WAITING_CONFIRM',
          proofText,
          proofImages,
          submittedAt: now,
          updatedAt: now
        }
      })

      await transaction.collection('tasks').doc(order.taskId).update({
        data: {
          status: 'WAITING_CONFIRM',
          proofText,
          proofImages,
          submittedAt: now,
          updatedAt: now
        }
      })

      return {
        orderId,
        taskId: order.taskId,
        status: 'WAITING_CONFIRM',
        receiverId: order.publisherId,
        title: order.title
      }
    })

    await createNotification({ type: 'TASK_SUBMITTED', receiverId: transactionResult.receiverId, actorId: workerId, taskId: transactionResult.taskId, orderId, taskTitle: transactionResult.title, contentPreview: '接单者已提交完成凭证，请及时确认' })

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

    console.error('接单者提交完成事务失败：', error)
    return {
      success: false,
      code: 'SUBMIT_TASK_FAILED',
      message: '提交完成失败，请稍后重试'
    }
  }
}
