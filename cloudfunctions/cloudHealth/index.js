const cloud = require('wx-server-sdk')

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

exports.main = async () => {
  const wxContext = cloud.getWXContext()

  return {
    success: true,
    message: 'CloudBase connected',
    openid: wxContext.OPENID,
    serverTime: new Date().toISOString()
  }
}
