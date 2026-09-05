const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function createUserId(appid, openid) {
  const hash = crypto.createHash('sha256').update(`${appid}:${openid}`).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function formatChinaDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const china = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const parts = [china.getUTCFullYear(), String(china.getUTCMonth() + 1).padStart(2, '0'), String(china.getUTCDate()).padStart(2, '0')]
  return `${parts.join('-')} ${String(china.getUTCHours()).padStart(2, '0')}:${String(china.getUTCMinutes()).padStart(2, '0')}`
}

function isMissing(error) {
  const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(text)
}

async function requireAdmin(userId) {
  try {
    const result = await db.collection('users').doc(userId).get()
    return result.data && result.data.role === 'ADMIN'
  } catch (error) {
    return false
  }
}

async function listReports() {
  let result
  try {
    result = await db.collection('reports').limit(50).get()
  } catch (error) {
    if (isMissing(error)) return { success: true, reports: [] }
    throw error
  }

  const reports = await Promise.all(result.data
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(async (report) => {
      let postContent = '帖子已不存在'
      try {
        const post = await db.collection('posts').doc(report.postId).get()
        postContent = String(post.data.content || '').slice(0, 160)
      } catch (error) {}
      return {
        id: report._id,
        postId: report.postId,
        reason: report.reason,
        status: report.status || 'PENDING',
        decision: report.decision || '',
        postContent,
        createdAt: formatChinaDate(report.createdAt)
      }
    }))
  return { success: true, reports }
}

async function resolveReport(event, adminId) {
  const reportId = String(event.reportId || '').trim()
  const decision = String(event.decision || '').trim()
  if (!reportId || reportId.length > 128 || !['REMOVE', 'DISMISS'].includes(decision)) {
    return { success: false, code: 'INVALID_REQUEST', message: '审核参数无效' }
  }

  const result = await db.runTransaction(async (transaction) => {
    let reportResult
    try {
      reportResult = await transaction.collection('reports').doc(reportId).get()
    } catch (error) {
      throw new Error('REPORT_NOT_FOUND')
    }
    const report = reportResult.data
    if (report.status === 'RESOLVED') throw new Error('REPORT_RESOLVED')
    const now = db.serverDate()
    if (decision === 'REMOVE') {
      try {
        await transaction.collection('posts').doc(report.postId).update({
          data: { status: 'REMOVED', removedAt: now, removedBy: adminId, updatedAt: now }
        })
      } catch (error) {
        throw new Error('POST_NOT_FOUND')
      }
    }
    await transaction.collection('reports').doc(reportId).update({
      data: { status: 'RESOLVED', decision, handledBy: adminId, handledAt: now, updatedAt: now }
    })
    return { reportId, decision }
  })
  return { success: true, result }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  if (!wxContext.OPENID || !wxContext.APPID) {
    return { success: false, code: 'WX_CONTEXT_MISSING', message: '无法获取微信用户身份' }
  }
  const userId = createUserId(wxContext.APPID, wxContext.OPENID)
  if (!(await requireAdmin(userId))) {
    return { success: false, code: 'ADMIN_REQUIRED', message: '没有管理员权限' }
  }

  try {
    if (event.action === 'listReports') return await listReports()
    if (event.action === 'resolveReport') return await resolveReport(event, userId)
    return { success: false, code: 'INVALID_ACTION', message: '不支持的管理操作' }
  } catch (error) {
    const text = String(error && error.message)
    const messages = {
      REPORT_NOT_FOUND: '举报记录不存在',
      REPORT_RESOLVED: '举报已经处理',
      POST_NOT_FOUND: '对应帖子不存在'
    }
    const code = Object.keys(messages).find((item) => text.includes(item))
    if (code) return { success: false, code, message: messages[code] }
    console.error('管理员接口执行失败：', error)
    return { success: false, code: 'ADMIN_API_FAILED', message: '管理操作失败，请稍后重试' }
  }
}
