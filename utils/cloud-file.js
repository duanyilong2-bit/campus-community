const TEMP_URL_BATCH_SIZE = 50

async function getTempFileUrlMap(fileIds) {
  const uniqueFileIds = Array.from(new Set(
    fileIds.filter((fileId) => (
      typeof fileId === 'string' && fileId.startsWith('cloud://')
    ))
  ))
  const urlMap = new Map()

  fileIds.forEach((fileId) => {
    if (typeof fileId === 'string' && /^https?:\/\//.test(fileId)) {
      urlMap.set(fileId, fileId)
    }
  })

  for (let index = 0; index < uniqueFileIds.length; index += TEMP_URL_BATCH_SIZE) {
    const batch = uniqueFileIds.slice(index, index + TEMP_URL_BATCH_SIZE)
    const result = await wx.cloud.getTempFileURL({
      fileList: batch
    })

    const resultFiles = result.fileList || []
    resultFiles.forEach((file) => {
      if (file.fileID && file.tempFileURL) {
        urlMap.set(file.fileID, file.tempFileURL)
      }
    })
  }

  return urlMap
}

async function resolveImageField(items, fieldName) {
  const fileIds = items.reduce((allFileIds, item) => {
    const images = Array.isArray(item[fieldName]) ? item[fieldName] : []
    return allFileIds.concat(images)
  }, [])

  if (fileIds.length === 0) {
    return items.map((item) => ({
      ...item,
      [fieldName]: []
    }))
  }

  const urlMap = await getTempFileUrlMap(fileIds)

  return items.map((item) => ({
    ...item,
    [fieldName]: (Array.isArray(item[fieldName]) ? item[fieldName] : [])
      .map((fileId) => urlMap.get(fileId))
      .filter(Boolean)
  }))
}

async function resolveProofImages(items) {
  return resolveImageField(items, 'proofImages')
}

async function resolvePostImages(items) {
  return resolveImageField(items, 'postImages')
}

module.exports = {
  resolveProofImages,
  resolvePostImages
}
