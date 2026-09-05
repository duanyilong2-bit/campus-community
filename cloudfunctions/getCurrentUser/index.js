const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

const db = cloud.database()
const USERS_COLLECTION = 'users'

function createUserId(appid, openid) {
  const source = `${appid}:${openid}`
  const hash = crypto.createHash('sha256').update(source).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function isCollectionMissing(error) {
  const errorText = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(errorText)
}

async function createUserDocument(userId, openid) {
  const userData = {
    openid,
    nickname: '校园社区用户',
    avatarUrl: '',
    role: 'USER',
    createdAt: db.serverDate(),
    updatedAt: db.serverDate()
  }

  try {
    await db.collection(USERS_COLLECTION).doc(userId).set({
      data: userData
    })
  } catch (error) {
    if (!isCollectionMissing(error) || typeof db.createCollection !== 'function') {
      throw error
    }

    await db.createCollection(USERS_COLLECTION)
    await db.collection(USERS_COLLECTION).doc(userId).set({
      data: userData
    })
  }

  return db.collection(USERS_COLLECTION).doc(userId).get()
}

async function getAvatarDisplayUrl(fileId) {
  if (!fileId || typeof fileId !== 'string') {
    return ''
  }
  if (/^https?:\/\//.test(fileId)) {
    return fileId
  }
  if (!fileId.startsWith('cloud://')) {
    return ''
  }

  try {
    const result = await cloud.getTempFileURL({ fileList: [fileId] })
    const file = (result.fileList || [])[0]
    return file && file.tempFileURL ? file.tempFileURL : ''
  } catch (error) {
    console.error('生成头像临时地址失败：', error)
    return ''
  }
}

exports.main = async () => {
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

  const userId = createUserId(appid, openid)
  let userResult
  let created = false

  try {
    userResult = await db.collection(USERS_COLLECTION).doc(userId).get()
  } catch (error) {
    try {
      userResult = await createUserDocument(userId, openid)
      created = true
    } catch (createError) {
      console.error('创建当前用户失败：', createError)
      return {
        success: false,
        code: isCollectionMissing(createError)
          ? 'USERS_COLLECTION_MISSING'
          : 'USER_CREATE_FAILED',
        message: isCollectionMissing(createError)
          ? 'users 集合尚未创建'
          : '创建当前用户失败'
      }
    }
  }

  const user = userResult.data
  if (user.nickname === '校园帮用户') {
    user.nickname = '校园社区用户'
    await db.collection(USERS_COLLECTION).doc(userId).update({
      data: {
        nickname: user.nickname,
        updatedAt: db.serverDate()
      }
    })
  }
  const avatarUrl = await getAvatarDisplayUrl(user.avatarUrl)

  return {
    success: true,
    created,
    user: {
      id: user._id,
      nickname: user.nickname,
      avatarUrl,
      hasAvatar: Boolean(user.avatarUrl),
      role: user.role,
      accountStatus: user.accountStatus || 'ACTIVE',
      campusVerificationStatus: user.campusVerificationStatus || 'UNVERIFIED',
      subscriptionEnabled: Boolean(user.subscriptionEnabled),
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }
  }
}
