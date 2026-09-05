const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const USERS_COLLECTION = 'users'
const TASKS_COLLECTION = 'tasks'
const CATEGORIES = ['跑腿', '代购', '打印', '日常事务', '兼职', '其他']

function createUserId(appid, openid) {
  const source = `${appid}:${openid}`
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function parseDeadline(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:\s(\d{2}):(\d{2}))?$/.exec(value)
  if (!match) {
    return null
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hasTime = match[4] !== undefined
  const hour = hasTime ? Number(match[4]) : 23
  const minute = hasTime ? Number(match[5]) : 59

  if (hour > 23 || minute > 59) {
    return null
  }

  // 前端填写北京时间，数据库统一保存为 UTC Date。
  const deadline = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, hasTime ? 0 : 59, hasTime ? 0 : 999))
  const checkDate = new Date(deadline.getTime() + 8 * 60 * 60 * 1000)

  if (
    checkDate.getUTCFullYear() !== year ||
    checkDate.getUTCMonth() !== month - 1 ||
    checkDate.getUTCDate() !== day ||
    checkDate.getUTCHours() !== hour ||
    checkDate.getUTCMinutes() !== minute
  ) {
    return null
  }

  return deadline
}

function validateTask(event) {
  const title = String(event.title || '').trim()
  const category = String(event.category || '').trim()
  const description = String(event.description || '').trim()
  const location = String(event.location || '').trim()
  const rewardText = String(event.reward ?? '').trim()
  const reward = Number(rewardText)
  const deadlineText = String(event.deadline || '').trim()
  const deadline = parseDeadline(deadlineText)
  const isAnonymous = event.isAnonymous === true

  if (!title || title.length > 30) {
    return { error: 'INVALID_TITLE', message: '任务标题不能为空且不能超过30个字' }
  }

  if (!CATEGORIES.includes(category)) {
    return { error: 'INVALID_CATEGORY', message: '请选择有效的任务分类' }
  }

  if (!description || description.length > 200) {
    return { error: 'INVALID_DESCRIPTION', message: '任务描述不能为空且不能超过200个字' }
  }

  if (!rewardText || !Number.isFinite(reward) || reward < 0 || reward > 99999) {
    return { error: 'INVALID_REWARD', message: '请输入0到99999之间的有效报酬' }
  }

  if (!location || location.length > 50) {
    return { error: 'INVALID_LOCATION', message: '任务地点不能为空且不能超过50个字' }
  }

  if (!deadline || deadline.getTime() < Date.now()) {
    return { error: 'INVALID_DEADLINE', message: '请选择有效且未过期的截止日期和时间' }
  }

  return {
    task: {
      title,
      category,
      description,
      reward: Math.round(reward * 100) / 100,
      location,
      deadline,
      isAnonymous
    }
  }
}

async function checkTextSecurity(content, openid) {
  try {
    const result = await cloud.openapi.security.msgSecCheck({
      openid,
      scene: 2,
      version: 2,
      content
    })
    const suggest = result && result.result ? result.result.suggest : ''
    return !suggest || suggest === 'pass'
  } catch (error) {
    console.error('任务文字安全检查暂不可用：', error)
    return true
  }
}

async function isPublishingTooFast(publisherId) {
  const result = await db.collection(TASKS_COLLECTION)
    .where({ publisherId })
    .limit(10)
    .get()
  const latestTime = result.data.reduce((max, task) => {
    const time = new Date(task.createdAt).getTime()
    return Number.isNaN(time) ? max : Math.max(max, time)
  }, 0)
  return latestTime > 0 && Date.now() - latestTime < 10000
}

exports.main = async (event) => {
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

  const validation = validateTask(event || {})

  if (validation.error) {
    return {
      success: false,
      code: validation.error,
      message: validation.message
    }
  }

  const publisherId = createUserId(appid, openid)

  try {
    const userResult = await db.collection(USERS_COLLECTION).doc(publisherId).get()
    if (userResult.data.accountStatus === 'SUSPENDED') {
      return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请联系客服' }
    }
  } catch (error) {
    console.error('发布任务时没有找到当前用户：', error)
    return {
      success: false,
      code: 'USER_NOT_FOUND',
      message: '当前用户尚未初始化，请重新进入小程序'
    }
  }

  const safeText = [validation.task.title, validation.task.description, validation.task.location].join('；')
  if (!(await checkTextSecurity(safeText, openid))) {
    return {
      success: false,
      code: 'CONTENT_RISK',
      message: '任务内容可能不符合平台规范，请修改后再发布'
    }
  }

  try {
    if (await isPublishingTooFast(publisherId)) {
      return {
        success: false,
        code: 'PUBLISH_TOO_FAST',
        message: '发布太频繁，请等待几秒后再试'
      }
    }
    const now = db.serverDate()
    const result = await db.collection(TASKS_COLLECTION).add({
      data: {
        publisherId,
        ...validation.task,
        status: 'WAITING',
        createdAt: now,
        updatedAt: now
      }
    })

    return {
      success: true,
      task: {
        id: result._id,
        publisherId,
        ...validation.task,
        deadline: event.deadline,
        status: 'WAITING'
      }
    }
  } catch (error) {
    console.error('发布云端任务失败：', error)
    return {
      success: false,
      code: 'PUBLISH_TASK_FAILED',
      message: '发布任务失败，请稍后重试'
    }
  }
}
