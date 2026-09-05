const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const FEEDBACK_CATEGORIES = ['功能问题', '使用建议', '账号问题', '内容举报', '其他']
const DISPUTE_REASONS = ['无法联系对方', '任务描述不一致', '完成结果有争议', '疑似违规任务', '其他']

function createUserId(appid, openid) {
  const hash = crypto.createHash('sha256').update(`${appid}:${openid}`).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`
}

function createImageCheckId(fileId) {
  return `image_${crypto.createHash('sha256').update(fileId).digest('hex').slice(0, 32)}`
}

async function isVerificationImageSafe(fileId, userId) {
  try {
    const result = await db.collection('image_security_checks').doc(createImageCheckId(fileId)).get()
    const check = result.data
    return check && check.fileId === fileId && check.userId === userId && check.purpose === 'VERIFICATION' && check.result === 'PASS'
  } catch (error) { return false }
}

function isMissing(error) {
  const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(text)
}

async function ensureCollection(name) {
  try {
    await db.collection(name).limit(1).get()
  } catch (error) {
    if (!isMissing(error) || typeof db.createCollection !== 'function') throw error
    try { await db.createCollection(name) } catch (createError) {
      if (!/already exist|已存在/i.test(String(createError.message || createError.errMsg))) throw createError
    }
  }
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return `${china.getUTCFullYear()}-${String(china.getUTCMonth() + 1).padStart(2, '0')}-${String(china.getUTCDate()).padStart(2, '0')} ${String(china.getUTCHours()).padStart(2, '0')}:${String(china.getUTCMinutes()).padStart(2, '0')}`
}

async function getUser(userId) {
  const result = await db.collection('users').doc(userId).get()
  return result.data
}

async function getList(name, where) {
  try {
    const result = await db.collection(name).where(where).limit(50).get()
    return result.data.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function createNotification(data) {
  try {
    await ensureCollection('notifications')
    const now = db.serverDate()
    await db.collection('notifications').add({ data: { ...data, actorName: '平台通知', actorAvatarUrl: '', isRead: false, createdAt: now, updatedAt: now } })
  } catch (error) { console.error('创建安全中心通知失败：', error) }
}

async function getCenterData(userId) {
  const user = await getUser(userId)
  const [verifications, feedback, ownDisputes, relatedDisputes] = await Promise.all([
    getList('verifications', { userId }),
    getList('feedback', { userId }),
    getList('disputes', { userId }),
    getList('disputes', { otherUserId: userId })
  ])
  const disputeMap = new Map([...ownDisputes, ...relatedDisputes].map((item) => [item._id, item]))
  const disputes = Array.from(disputeMap.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  return {
    success: true,
    accountStatus: user.accountStatus || 'ACTIVE',
    verificationStatus: user.campusVerificationStatus || 'UNVERIFIED',
    subscriptionEnabled: Boolean(user.subscriptionEnabled),
    verification: verifications[0] ? { ...verifications[0], id: verifications[0]._id, createdAt: formatDate(verifications[0].createdAt) } : null,
    feedback: feedback.map((item) => ({ id: item._id, category: item.category, content: item.content, status: item.status, createdAt: formatDate(item.createdAt) })),
    disputes: disputes.map((item) => ({ id: item._id, orderId: item.orderId, title: item.title, reason: item.reason, description: item.description, status: item.status, resultText: item.resultText || '', createdAt: formatDate(item.createdAt) }))
  }
}

async function submitVerification(event, userId) {
  const studentNoLast4 = String(event.studentNoLast4 || '').trim().toUpperCase()
  const proofFileId = String(event.proofFileId || '').trim()
  if (!/^[A-Z0-9]{4,8}$/.test(studentNoLast4)) return { success: false, code: 'INVALID_STUDENT_CODE', message: '请填写学号后4到8位' }
  if (!proofFileId.startsWith('cloud://') || !proofFileId.includes(`/verification-proofs/${userId}/`)) return { success: false, code: 'INVALID_PROOF', message: '认证图片无效' }
  if (!(await isVerificationImageSafe(proofFileId, userId))) return { success: false, code: 'IMAGE_NOT_CHECKED', message: '认证图片尚未通过安全检查' }

  const user = await getUser(userId)
  if (user.campusVerificationStatus === 'PENDING') return { success: false, code: 'ALREADY_PENDING', message: '认证正在审核中' }
  await ensureCollection('verifications')
  const now = db.serverDate()
  const result = await db.collection('verifications').add({ data: { userId, studentNoLast4, proofFileId, status: 'PENDING', createdAt: now, updatedAt: now } })
  await db.collection('users').doc(userId).update({ data: { campusVerificationStatus: 'PENDING', updatedAt: now } })
  return { success: true, verificationId: result._id }
}

async function submitFeedback(event, userId) {
  const category = String(event.category || '').trim()
  const content = String(event.content || '').trim()
  if (!FEEDBACK_CATEGORIES.includes(category) || content.length < 5 || content.length > 500) return { success: false, code: 'INVALID_FEEDBACK', message: '请选择分类并填写5到500字内容' }
  await ensureCollection('feedback')
  const now = db.serverDate()
  const result = await db.collection('feedback').add({ data: { userId, category, content, status: 'OPEN', createdAt: now, updatedAt: now } })
  return { success: true, feedbackId: result._id }
}

async function createDispute(event, userId) {
  const orderId = String(event.orderId || '').trim()
  const reason = String(event.reason || '').trim()
  const description = String(event.description || '').trim()
  if (!orderId || !DISPUTE_REASONS.includes(reason) || description.length < 5 || description.length > 500) return { success: false, code: 'INVALID_DISPUTE', message: '请完整填写争议原因和说明' }
  let orderResult
  try { orderResult = await db.collection('orders').doc(orderId).get() } catch (error) { return { success: false, code: 'ORDER_NOT_FOUND', message: '订单不存在' } }
  const order = orderResult.data
  if (![order.publisherId, order.workerId].includes(userId)) return { success: false, code: 'NOT_ORDER_PARTICIPANT', message: '只能申请处理自己的订单' }
  await ensureCollection('disputes')
  const existing = await db.collection('disputes').where({ orderId, userId, status: 'OPEN' }).limit(1).get()
  if (existing.data.length) return { success: false, code: 'DISPUTE_EXISTS', message: '该订单已有待处理申请' }
  const now = db.serverDate()
  const result = await db.collection('disputes').add({ data: { orderId, taskId: order.taskId, userId, otherUserId: order.publisherId === userId ? order.workerId : order.publisherId, title: order.title, reason, description, status: 'OPEN', createdAt: now, updatedAt: now } })
  return { success: true, disputeId: result._id }
}

async function setSubscription(event, userId) {
  const enabled = Boolean(event.enabled)
  await db.collection('users').doc(userId).update({ data: { subscriptionEnabled: enabled, updatedAt: db.serverDate() } })
  return { success: true, enabled }
}

async function getAdminQueue() {
  const [verifications, feedback, disputes, suspendedUsers] = await Promise.all([
    getList('verifications', { status: 'PENDING' }),
    getList('feedback', { status: 'OPEN' }),
    getList('disputes', { status: 'OPEN' }),
    getList('users', { accountStatus: 'SUSPENDED' })
  ])
  const format = (items) => items.map((item) => ({ ...item, id: item._id, createdAt: formatDate(item.createdAt), proofFileId: undefined }))
  const proofIds = verifications.map((item) => item.proofFileId).filter(Boolean)
  const proofResult = proofIds.length ? await cloud.getTempFileURL({ fileList: proofIds }) : { fileList: [] }
  const proofMap = new Map((proofResult.fileList || []).map((item) => [item.fileID, item.tempFileURL]))
  return { success: true, verifications: format(verifications).map((item, index) => ({ ...item, proofUrl: proofMap.get(verifications[index].proofFileId) || '' })), feedback: format(feedback), disputes: format(disputes), suspendedUsers: format(suspendedUsers).map((item) => ({ id: item.id, nickname: item.nickname || '校园社区用户' })) }
}

async function reviewVerification(event, adminId) {
  const id = String(event.id || '').trim()
  const approved = Boolean(event.approved)
  const record = await db.collection('verifications').doc(id).get()
  const status = approved ? 'VERIFIED' : 'REJECTED'
  const now = db.serverDate()
  await db.runTransaction(async (transaction) => {
    await transaction.collection('verifications').doc(id).update({ data: { status, reviewedBy: adminId, reviewedAt: now, updatedAt: now } })
    await transaction.collection('users').doc(record.data.userId).update({ data: { campusVerificationStatus: status, updatedAt: now } })
  })
  await createNotification({ type: 'VERIFICATION_RESULT', receiverId: record.data.userId, actorId: adminId, contentPreview: approved ? '你的校园认证已通过' : '你的校园认证未通过，请修改资料后重新提交' })
  return { success: true }
}

async function resolveRecord(event, adminId, collectionName) {
  const id = String(event.id || '').trim()
  const resultText = String(event.resultText || '').trim().slice(0, 300)
  if (!id || !resultText) return { success: false, code: 'INVALID_RESULT', message: '请填写处理结果' }
  const record = await db.collection(collectionName).doc(id).get()
  await db.collection(collectionName).doc(id).update({ data: { status: 'RESOLVED', resultText, handledBy: adminId, handledAt: db.serverDate(), updatedAt: db.serverDate() } })
  await createNotification({
    type: collectionName === 'disputes' ? 'DISPUTE_RESULT' : 'FEEDBACK_RESULT',
    receiverId: record.data.userId,
    actorId: adminId,
    orderId: record.data.orderId || '',
    taskId: record.data.taskId || '',
    taskTitle: record.data.title || '',
    contentPreview: resultText
  })
  if (collectionName === 'disputes' && record.data.otherUserId && record.data.otherUserId !== record.data.userId) {
    await createNotification({
      type: 'DISPUTE_RESULT',
      receiverId: record.data.otherUserId,
      actorId: adminId,
      orderId: record.data.orderId || '',
      taskId: record.data.taskId || '',
      taskTitle: record.data.title || '',
      contentPreview: resultText
    })
  }
  return { success: true }
}

async function setAccountStatus(event, adminId) {
  const targetUserId = String(event.targetUserId || '').trim()
  const status = String(event.status || '')
  if (!targetUserId || !['ACTIVE', 'SUSPENDED'].includes(status) || targetUserId === adminId) return { success: false, code: 'INVALID_ACCOUNT_ACTION', message: '账号操作无效' }
  await db.collection('users').doc(targetUserId).update({ data: { accountStatus: status, statusUpdatedBy: adminId, statusUpdatedAt: db.serverDate(), updatedAt: db.serverDate() } })
  await createNotification({ type: 'ACCOUNT_STATUS', receiverId: targetUserId, actorId: adminId, contentPreview: status === 'SUSPENDED' ? '你的账号已被暂停，请通过安全中心联系客服' : '你的账号已恢复正常使用' })
  return { success: true }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  if (!wxContext.OPENID || !wxContext.APPID) return { success: false, code: 'WX_CONTEXT_MISSING', message: '无法获取微信用户身份' }
  const userId = createUserId(wxContext.APPID, wxContext.OPENID)
  let user
  try { user = await getUser(userId) } catch (error) { return { success: false, code: 'USER_NOT_FOUND', message: '用户尚未初始化' } }
  if ((user.accountStatus || 'ACTIVE') === 'SUSPENDED' && !['getCenterData', 'submitFeedback'].includes(event.action)) return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请联系客服' }

  const adminActions = ['getAdminQueue', 'reviewVerification', 'resolveDispute', 'resolveFeedback', 'setAccountStatus']
  if (adminActions.includes(event.action) && user.role !== 'ADMIN') return { success: false, code: 'ADMIN_REQUIRED', message: '没有管理员权限' }
  try {
    const actions = {
      getCenterData: () => getCenterData(userId),
      submitVerification: () => submitVerification(event, userId),
      submitFeedback: () => submitFeedback(event, userId),
      createDispute: () => createDispute(event, userId),
      setSubscription: () => setSubscription(event, userId),
      getAdminQueue: () => getAdminQueue(),
      reviewVerification: () => reviewVerification(event, userId),
      resolveDispute: () => resolveRecord(event, userId, 'disputes'),
      resolveFeedback: () => resolveRecord(event, userId, 'feedback'),
      setAccountStatus: () => setAccountStatus(event, userId)
    }
    if (!actions[event.action]) return { success: false, code: 'INVALID_ACTION', message: '不支持的安全中心操作' }
    return await actions[event.action]()
  } catch (error) {
    console.error('safetyApi 执行失败：', event.action, error)
    return { success: false, code: 'SAFETY_API_FAILED', message: '操作失败，请稍后重试' }
  }
}
