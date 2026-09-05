async function checkFiles(fileIds, purpose, relatedId = '') {
  for (const fileId of fileIds) {
    const response = await wx.cloud.callFunction({
      name: 'imageSecurity',
      data: { fileId, purpose, relatedId }
    })
    const result = response.result || {}
    if (!result.success) {
      const error = new Error(result.message || '图片安全检查失败')
      error.code = result.code || 'IMAGE_CHECK_FAILED'
      throw error
    }
  }
  return fileIds
}

async function removeFiles(fileIds) {
  if (!Array.isArray(fileIds) || fileIds.length === 0) return
  try { await wx.cloud.deleteFile({ fileList: fileIds }) } catch (error) { console.error('清理未使用图片失败：', error) }
}

module.exports = { checkFiles, removeFiles }
