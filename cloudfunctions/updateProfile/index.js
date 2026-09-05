const crypto = require('crypto')
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function createUserId(appid, openid) {
  const hash = crypto.createHash('sha256').update(`${appid}:${openid}`).digest('hex')
  return `user_${hash.slice(0, 24)}`
}

function createImageCheckId(fileId) {
  return `image_${crypto.createHash('sha256').update(fileId).digest('hex').slice(0, 32)}`
}

async function isAvatarSafe(fileId, userId) {
  try {
    const result = await db.collection('image_security_checks').doc(createImageCheckId(fileId)).get()
    const check = result.data
    return check && check.fileId === fileId && check.userId === userId && check.purpose === 'AVATAR' && check.result === 'PASS'
  } catch (error) { return false }
}

function isCollectionMissing(error) {
  const text = `${error && error.errCode} ${error && error.errMsg} ${error && error.message}`
  return /collection.*(not exist|不存在)|DATABASE_COLLECTION_NOT_EXIST/i.test(text)
}

async function getAvatarDisplayUrl(fileId) {
  if (!fileId) {
    return ''
  }
  const result = await cloud.getTempFileURL({ fileList: [fileId] })
  const file = (result.fileList || [])[0]
  return file && file.tempFileURL ? file.tempFileURL : ''
}

async function syncForumProfile(collectionName, userId, profileData) {
  try {
    await db.collection(collectionName).where({ authorId: userId }).update({
      data: profileData
    })
  } catch (error) {
    if (!isCollectionMissing(error)) {
      throw error
    }
  }
}

exports.main = async (event = {}) => {
  const wxContext = cloud.getWXContext()
  if (!wxContext.OPENID || !wxContext.APPID) {
    return { success: false, code: 'WX_CONTEXT_MISSING', message: '无法获取微信用户身份' }
  }

  const userId = createUserId(wxContext.APPID, wxContext.OPENID)
  const nickname = String(event.nickname || '').trim()
  const hasAvatarField = Object.prototype.hasOwnProperty.call(event, 'avatarFileId')
  const avatarFileId = hasAvatarField ? String(event.avatarFileId || '').trim() : ''

  if (nickname.length < 2 || nickname.length > 16) {
    return { success: false, code: 'INVALID_NICKNAME', message: '昵称需要2到16个字' }
  }

  if (/\s{2,}/.test(nickname) || /[<>]/.test(nickname)) {
    return { success: false, code: 'INVALID_NICKNAME', message: '昵称包含不合适的字符' }
  }

  if (hasAvatarField) {
    const expectedPath = `/user-avatars/${userId}/`
    if (
      !avatarFileId ||
      avatarFileId.length > 1024 ||
      !avatarFileId.startsWith('cloud://') ||
      !avatarFileId.includes(expectedPath)
    ) {
      return { success: false, code: 'INVALID_AVATAR', message: '头像文件无效，请重新选择' }
    }
    if (!(await isAvatarSafe(avatarFileId, userId))) {
      return { success: false, code: 'IMAGE_NOT_CHECKED', message: '头像尚未通过安全检查，请重新选择' }
    }
  }

  try {
    const userResult = await db.collection('users').doc(userId).get()
    const currentUser = userResult.data
    if (currentUser.accountStatus === 'SUSPENDED') {
      return { success: false, code: 'ACCOUNT_SUSPENDED', message: '账号已被暂停使用，请联系客服' }
    }
    const storedAvatarFileId = hasAvatarField ? avatarFileId : (currentUser.avatarUrl || '')
    const now = db.serverDate()

    await db.collection('users').doc(userId).update({
      data: {
        nickname,
        avatarUrl: storedAvatarFileId,
        updatedAt: now
      }
    })

    await Promise.all([
      syncForumProfile('posts', userId, {
        authorName: nickname,
        authorAvatarUrl: storedAvatarFileId,
        updatedAt: now
      }),
      syncForumProfile('comments', userId, {
        authorName: nickname,
        authorAvatarUrl: storedAvatarFileId,
        updatedAt: now
      })
    ])

    return {
      success: true,
      user: {
        id: userId,
        nickname,
        avatarUrl: await getAvatarDisplayUrl(storedAvatarFileId),
        hasAvatar: Boolean(storedAvatarFileId),
        role: currentUser.role || 'USER'
      }
    }
  } catch (error) {
    console.error('更新用户资料失败：', error)
    return { success: false, code: 'UPDATE_PROFILE_FAILED', message: '保存个人资料失败，请稍后重试' }
  }
}
