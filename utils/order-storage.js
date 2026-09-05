const taskStorage = require('./task-storage')

const STORAGE_KEY = 'campusOrders'

const ORDER_STATUS = {
  ACCEPTED: 'ACCEPTED',
  WAITING_CONFIRM: 'WAITING_CONFIRM',
  COMPLETED: 'COMPLETED'
}

const STATUS_TEXT = {
  ACCEPTED: '已接单',
  WAITING_CONFIRM: '待发布者确认',
  COMPLETED: '已完成'
}

function formatDateTime(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function normalizeOrder(order) {
  const oldStatusMap = {
    '已接单': ORDER_STATUS.ACCEPTED,
    '待发布者确认': ORDER_STATUS.WAITING_CONFIRM,
    '已完成': ORDER_STATUS.COMPLETED
  }

  return {
    ...order,
    status: oldStatusMap[order.status] || order.status || ORDER_STATUS.ACCEPTED
  }
}

function addStatusText(order) {
  const normalizedOrder = normalizeOrder(order)
  return {
    ...normalizedOrder,
    statusText: STATUS_TEXT[normalizedOrder.status] || '未知状态'
  }
}

function getStoredOrders() {
  const orders = wx.getStorageSync(STORAGE_KEY)
  return Array.isArray(orders) ? orders : []
}

function getAllOrders() {
  return getStoredOrders().map(addStatusText)
}

function acceptTask(taskId) {
  const task = taskStorage.getTaskById(taskId)

  if (!task) {
    return { success: false, reason: 'TASK_NOT_FOUND' }
  }

  if (task.status === taskStorage.TASK_STATUS.ACCEPTED) {
    return { success: false, reason: 'ALREADY_ACCEPTED' }
  }

  if (task.status === taskStorage.TASK_STATUS.WAITING_CONFIRM) {
    return { success: false, reason: 'WAITING_CONFIRM' }
  }

  if (task.status === taskStorage.TASK_STATUS.COMPLETED) {
    return { success: false, reason: 'ALREADY_COMPLETED' }
  }

  const orders = getStoredOrders().map(normalizeOrder)
  const duplicateOrder = orders.find(
    (order) => String(order.taskId) === String(taskId)
  )

  if (duplicateOrder) {
    return { success: false, reason: 'DUPLICATE_ORDER' }
  }

  const taskResult = taskStorage.updateTaskStatus(
    taskId,
    taskStorage.TASK_STATUS.WAITING,
    taskStorage.TASK_STATUS.ACCEPTED
  )

  if (!taskResult.success) {
    return { success: false, reason: 'STATUS_CHANGED' }
  }

  const now = new Date()
  const order = {
    id: `order_${now.getTime()}_${Math.floor(Math.random() * 1000)}`,
    taskId: task.id,
    title: task.title,
    category: task.category,
    description: task.description,
    reward: task.reward,
    location: task.location,
    status: ORDER_STATUS.ACCEPTED,
    createdAt: task.createdAt,
    acceptedAt: formatDateTime(now)
  }

  try {
    orders.unshift(order)
    wx.setStorageSync(STORAGE_KEY, orders)
  } catch (error) {
    // 如果订单保存失败，尽量将任务恢复为待接单，避免数据不同步。
    taskStorage.updateTaskStatus(
      taskId,
      taskStorage.TASK_STATUS.ACCEPTED,
      taskStorage.TASK_STATUS.WAITING
    )
    throw error
  }

  return {
    success: true,
    order: addStatusText(order)
  }
}

function submitOrderForConfirmation(orderId) {
  const orders = getStoredOrders().map(normalizeOrder)
  const orderIndex = orders.findIndex(
    (order) => String(order.id) === String(orderId)
  )

  if (orderIndex === -1) {
    return { success: false, reason: 'ORDER_NOT_FOUND' }
  }

  const order = orders[orderIndex]

  if (order.status === ORDER_STATUS.COMPLETED) {
    return { success: false, reason: 'ALREADY_COMPLETED' }
  }

  if (order.status === ORDER_STATUS.WAITING_CONFIRM) {
    return { success: false, reason: 'ALREADY_SUBMITTED' }
  }

  const task = taskStorage.getTaskById(order.taskId)

  if (!task) {
    return { success: false, reason: 'TASK_NOT_FOUND' }
  }

  const taskResult = taskStorage.updateTaskStatus(
    order.taskId,
    taskStorage.TASK_STATUS.ACCEPTED,
    taskStorage.TASK_STATUS.WAITING_CONFIRM
  )

  if (!taskResult.success) {
    return { success: false, reason: 'STATUS_CHANGED' }
  }

  const updatedOrder = {
    ...order,
    status: ORDER_STATUS.WAITING_CONFIRM,
    submittedAt: formatDateTime(new Date())
  }
  orders[orderIndex] = updatedOrder

  try {
    wx.setStorageSync(STORAGE_KEY, orders)
  } catch (error) {
    // 如果订单保存失败，尽量恢复任务状态。
    taskStorage.updateTaskStatus(
      order.taskId,
      taskStorage.TASK_STATUS.WAITING_CONFIRM,
      taskStorage.TASK_STATUS.ACCEPTED
    )
    throw error
  }

  return {
    success: true,
    order: addStatusText(updatedOrder)
  }
}

function confirmTaskCompletion(taskId) {
  const task = taskStorage.getTaskById(taskId)

  if (!task) {
    return { success: false, reason: 'TASK_NOT_FOUND' }
  }

  if (!task.isLocalPublished) {
    return { success: false, reason: 'NOT_LOCAL_PUBLISHED' }
  }

  if (task.status === taskStorage.TASK_STATUS.COMPLETED) {
    return { success: false, reason: 'ALREADY_COMPLETED' }
  }

  if (task.status !== taskStorage.TASK_STATUS.WAITING_CONFIRM) {
    return { success: false, reason: 'INVALID_TASK_STATUS' }
  }

  const orders = getStoredOrders().map(normalizeOrder)
  const orderIndex = orders.findIndex(
    (order) => String(order.taskId) === String(taskId)
  )

  if (orderIndex === -1) {
    return { success: false, reason: 'ORDER_NOT_FOUND' }
  }

  const order = orders[orderIndex]

  if (order.status !== ORDER_STATUS.WAITING_CONFIRM) {
    return { success: false, reason: 'INVALID_ORDER_STATUS' }
  }

  const taskResult = taskStorage.updateTaskStatus(
    taskId,
    taskStorage.TASK_STATUS.WAITING_CONFIRM,
    taskStorage.TASK_STATUS.COMPLETED
  )

  if (!taskResult.success) {
    return { success: false, reason: 'STATUS_CHANGED' }
  }

  const updatedOrder = {
    ...order,
    status: ORDER_STATUS.COMPLETED,
    completedAt: formatDateTime(new Date())
  }
  orders[orderIndex] = updatedOrder

  try {
    wx.setStorageSync(STORAGE_KEY, orders)
  } catch (error) {
    // 如果订单保存失败，尽量恢复任务状态。
    taskStorage.updateTaskStatus(
      taskId,
      taskStorage.TASK_STATUS.COMPLETED,
      taskStorage.TASK_STATUS.WAITING_CONFIRM
    )
    throw error
  }

  return {
    success: true,
    task: taskResult.task,
    order: addStatusText(updatedOrder)
  }
}

module.exports = {
  STORAGE_KEY,
  ORDER_STATUS,
  acceptTask,
  confirmTaskCompletion,
  submitOrderForConfirmation,
  getAllOrders
}
