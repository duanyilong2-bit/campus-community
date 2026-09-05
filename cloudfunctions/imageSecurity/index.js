const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const COLLECTION = 'image_security_checks'
const MAX_FILE_SIZE = 1024 * 1024
const PURPOSES = ['POST', 'TASK_PROOF', 'AVATAR', 'VERIFICATION']

function createUserId(appid, openid) {
  return `user_${crypto.createHash('sha256').update(`${appid}:${openid}`).digest('hex').slice(0, 24)}`
}

function createCheckId(fileId) {
  return `image_${crypto.createHash('sha256').update(fileId).digest('hex').slice(0, 32)}`
}

function isMissing(error) {
  const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(text)
}

async function ensureCollection() {
  try {
    await db.collection(COLLECTION).limit(1).get()
  } catch (error) {
    if (!isMissing(error) || typeof db.createCollection !== 'function') throw error
    try { await db.createCollection(COLLECTION) } catch (createError) {
      if (!/already exist|已存在/i.test(String(createError.message || createError.errMsg))) throw createError
    }
  }
}

function detectContentType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return ''
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (['GIF8'].includes(buffer.slice(0, 4).toString())) return 'image/gif'
  return ''
}

async function verifyOwnership(fileId, purpose, relatedId, userId) {
  const pathRules = {
    POST: `/forum-posts/${userId}/`,
    AVATAR: `/user-avatars/${userId}/`,
    VERIFICATION: `/verification-proofs/${userId}/`,
    TASK_PROOF: `/task-proofs/${relatedId}/`
  }
  if (!fileId.startsWith('cloud://') || !fileId.includes(pathRules[purpose])) return false
  if (purpose !== 'TASK_PROOF') return true
  try {
    const order = await db.collection('orders').doc(relatedId).get()
    return order.data && order.data.workerId === userId && order.data.status === 'ACCEPTED'
  } catch (error) {
    return false
  }
}

async function removeUnsafeFile(fileId) {
  try { await cloud.deleteFile({ fileList: [fileId] }) } catch (error) { console.error('删除不安全图片失败：', error) }
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext()
  if (!context.OPENID || !context.APPID) return { success: false, code: 'WX_CONTEXT_MISSING', message: '无法获取微信用户身份' }
  const userId = createUserId(context.APPID, context.OPENID)
  const fileId = String(event.fileId || '').trim()
  const purpose = String(event.purpose || '').trim()
  const relatedId = String(event.relatedId || '').trim()
  if (!fileId || fileId.length > 1024 || !PURPOSES.includes(purpose)) return { success: false, code: 'INVALID_IMAGE', message: '图片参数无效' }
  try {
    const user = await db.collection('users').doc(userId).get()
    if (user.data && user.data.accountStatus === 'SUSPENDED') return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用' }
  } catch (error) {
    return { success: false, code: 'USER_NOT_FOUND', message: '用户身份尚未初始化' }
  }
  if (!(await verifyOwnership(fileId, purpose, relatedId, userId))) return { success: false, code: 'IMAGE_NOT_OWNED', message: '图片路径或归属校验失败' }

  await ensureCollection()
  const checkId = createCheckId(fileId)
  try {
    const existing = await db.collection(COLLECTION).doc(checkId).get()
    if (existing.data && existing.data.userId === userId && existing.data.result === 'PASS') return { success: true, checked: true, reused: true }
  } catch (error) {}

  try {
    const download = await cloud.downloadFile({ fileID: fileId })
    const buffer = download.fileContent
    const contentType = detectContentType(buffer)
    if (!contentType || !buffer.length || buffer.length > MAX_FILE_SIZE) {
      await removeUnsafeFile(fileId)
      return { success: false, code: 'INVALID_IMAGE_FORMAT', message: '只支持 1MB 以内的 JPG、PNG 或 GIF 图片' }
    }

    const checkResult = await cloud.openapi.security.imgSecCheck({ media: { contentType, value: buffer } })
    const checkCode = Number(checkResult.errCode || checkResult.errcode || 0)
    if (checkCode !== 0) {
      const checkError = new Error(checkResult.errMsg || checkResult.errmsg || 'IMAGE_CHECK_FAILED')
      checkError.errCode = checkCode
      throw checkError
    }
    const now = db.serverDate()
    await db.collection(COLLECTION).doc(checkId).set({
      data: { fileId, userId, purpose, relatedId, result: 'PASS', checkedAt: now, createdAt: now }
    })
    return { success: true, checked: true }
  } catch (error) {
    const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
    if (/87014|risky|risk|违规|不合规/i.test(text)) {
      await removeUnsafeFile(fileId)
      return { success: false, code: 'IMAGE_RISK', message: '图片可能包含不适宜内容，请更换后重试' }
    }
    console.error('图片安全检查失败：', error)
    return { success: false, code: 'IMAGE_CHECK_UNAVAILABLE', message: '图片安全检查暂时不可用，请稍后重试' }
  }
}
