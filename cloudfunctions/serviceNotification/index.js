const cloud = require('wx-server-sdk')
const templateConfig = require('./template-config')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const TASK_TYPES = ['TASK_ACCEPTED', 'TASK_SUBMITTED', 'TASK_COMPLETED']
const STATUS_TEXT = {
  TASK_ACCEPTED: '任务已接单',
  TASK_SUBMITTED: '待发布者确认',
  TASK_COMPLETED: '任务已完成'
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now())
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date
  const pad = (number) => String(number).padStart(2, '0')
  return `${safeDate.getFullYear()}-${pad(safeDate.getMonth() + 1)}-${pad(safeDate.getDate())} ${pad(safeDate.getHours())}:${pad(safeDate.getMinutes())}:${pad(safeDate.getSeconds())}`
}

function buildData(notification) {
  const fields = templateConfig.taskStatus.fields
  if (!fields.title || !fields.status || !fields.operatedAt || !fields.remark) return null
  return {
    [fields.title]: { value: String(notification.taskTitle || '校园互助任务').slice(0, 20) },
    [fields.status]: { value: String(STATUS_TEXT[notification.type] || '状态有更新').slice(0, 20) },
    [fields.operatedAt]: { value: formatTime(notification.createdAt) },
    [fields.remark]: { value: String(notification.contentPreview || '请进入小程序查看详情').slice(0, 20) }
  }
}

exports.main = async (event = {}) => {
  const notificationId = String(event.notificationId || '').trim()
  if (!notificationId || notificationId.length > 160) return { success: false, code: 'INVALID_NOTIFICATION_ID', message: '通知 ID 无效' }
  const config = templateConfig.taskStatus
  const data = buildData({})
  if (!config.templateId || !data) return { success: false, code: 'TEMPLATE_NOT_CONFIGURED', message: '订阅消息模板尚未配置' }

  try {
    const noticeResult = await db.collection('notifications').doc(notificationId).get()
    const notice = noticeResult.data
    if (!notice || !TASK_TYPES.includes(notice.type)) return { success: false, code: 'NOT_SUPPORTED', message: '这条站内通知不需要发送服务通知' }
    if (notice.serviceStatus === 'SENT') return { success: true, reused: true }

    const userResult = await db.collection('users').doc(notice.receiverId).get()
    const user = userResult.data || {}
    if (!user.subscriptionEnabled || !user.openid) {
      await db.collection('notifications').doc(notificationId).update({ data: { serviceStatus: 'DISABLED', serviceUpdatedAt: db.serverDate() } })
      return { success: false, code: 'NO_SUBSCRIPTION_QUOTA', message: '用户没有可用的订阅授权' }
    }

    const messageData = buildData(notice)
    const page = notice.taskId ? `pages/task-detail/task-detail?id=${encodeURIComponent(notice.taskId)}&source=cloud` : 'pages/notifications/notifications'
    await cloud.openapi.subscribeMessage.send({
      touser: user.openid,
      templateId: config.templateId,
      page,
      data: messageData,
      miniprogramState: config.miniprogramState || 'formal',
      lang: 'zh_CN'
    })

    await db.collection('notifications').doc(notificationId).update({
      data: { serviceStatus: 'SENT', serviceSentAt: db.serverDate(), serviceUpdatedAt: db.serverDate() }
    })
    // 当前使用的是一次性订阅：成功发送一次后，提示用户按需再次授权。
    await db.collection('users').doc(notice.receiverId).update({
      data: { subscriptionEnabled: false, updatedAt: db.serverDate() }
    })
    return { success: true }
  } catch (error) {
    console.error('发送微信服务通知失败：', error)
    try { await db.collection('notifications').doc(notificationId).update({ data: { serviceStatus: 'FAILED', serviceError: String(error.errCode || error.message || '').slice(0, 100), serviceUpdatedAt: db.serverDate() } }) } catch (updateError) {}
    return { success: false, code: 'SEND_FAILED', message: '服务通知发送失败，站内消息仍然有效' }
  }
}
