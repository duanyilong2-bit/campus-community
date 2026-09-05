const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function createUserId(appid, openid) {
  const hash = crypto.createHash('sha256').update(`${appid}:${openid}`).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

exports.main = async (event = {}) => {
  const taskId = String(event.taskId || '').trim()
  if (!taskId || taskId.length > 128) {
    return { success: false, code: 'INVALID_TASK_ID', message: '任务 ID 无效' }
  }

  const wxContext = cloud.getWXContext()
  if (!wxContext.OPENID || !wxContext.APPID) {
    return { success: false, code: 'WX_CONTEXT_MISSING', message: '无法获取微信用户身份' }
  }
  if (typeof db.runTransaction !== 'function') {
    return { success: false, code: 'TRANSACTION_UNAVAILABLE', message: '云端事务暂不可用' }
  }

  const publisherId = createUserId(wxContext.APPID, wxContext.OPENID)
  try {
    const userResult = await db.collection('users').doc(publisherId).get()
    if (userResult.data.accountStatus === 'SUSPENDED') {
      return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请联系客服' }
    }
    const result = await db.runTransaction(async (transaction) => {
      let taskResult
      try {
        taskResult = await transaction.collection('tasks').doc(taskId).get()
      } catch (error) {
        throw new Error('TASK_NOT_FOUND')
      }

      const task = taskResult.data
      if (task.publisherId !== publisherId) {
        throw new Error('NOT_TASK_PUBLISHER')
      }
      if (task.status !== 'WAITING') {
        throw new Error(task.status === 'CANCELLED' ? 'TASK_ALREADY_CANCELLED' : 'TASK_STATUS_CONFLICT')
      }

      const now = db.serverDate()
      await transaction.collection('tasks').doc(taskId).update({
        data: { status: 'CANCELLED', cancelledAt: now, updatedAt: now }
      })
      return { taskId, status: 'CANCELLED' }
    })
    return { success: true, task: result }
  } catch (error) {
    const text = String(error && error.message)
    const messages = {
      TASK_NOT_FOUND: '任务不存在',
      NOT_TASK_PUBLISHER: '只能取消自己发布的任务',
      TASK_ALREADY_CANCELLED: '任务已经取消',
      TASK_STATUS_CONFLICT: '只有待接单任务可以取消'
    }
    const code = Object.keys(messages).find((item) => text.includes(item))
    if (code) {
      return { success: false, code, message: messages[code] }
    }
    console.error('取消任务失败：', error)
    return { success: false, code: 'CANCEL_TASK_FAILED', message: '取消任务失败，请稍后重试' }
  }
}
