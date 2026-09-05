const STORAGE_KEY = 'campusTasks'

const TASK_STATUS = {
  WAITING: 'WAITING',
  ACCEPTED: 'ACCEPTED',
  WAITING_CONFIRM: 'WAITING_CONFIRM',
  COMPLETED: 'COMPLETED'
}

const STATUS_TEXT = {
  WAITING: '待接单',
  ACCEPTED: '已接单',
  WAITING_CONFIRM: '待发布者确认',
  COMPLETED: '已完成'
}

// 这些是第一次打开项目时显示的演示任务，不会写入本地存储。
const DEFAULT_TASKS = [
  {
    id: '1',
    title: '帮忙取快递',
    category: '跑腿',
    description: '请帮忙到学校东门取一个普通快递。',
    reward: 5,
    location: '学校东门',
    deadline: '2026-09-10',
    status: TASK_STATUS.WAITING,
    createdAt: '2026-09-01 09:00'
  },
  {
    id: '2',
    title: '帮忙打印资料',
    category: '打印',
    description: '需要打印一份学习资料，共十页。',
    reward: 3,
    location: '图书馆',
    deadline: '2026-09-12',
    status: TASK_STATUS.WAITING,
    createdAt: '2026-09-01 08:30'
  },
  {
    id: '3',
    title: '食堂帮忙带饭',
    category: '代购',
    description: '请帮忙从第一食堂带一份午饭。',
    reward: 6,
    location: '第一食堂',
    deadline: '2026-09-08',
    status: TASK_STATUS.WAITING,
    createdAt: '2026-09-01 08:00'
  },
  {
    id: '4',
    title: '整理活动报名表',
    category: '日常事务',
    description: '协助整理校园活动的纸质报名表。',
    reward: 10,
    location: '学生活动中心',
    deadline: '2026-09-15',
    status: TASK_STATUS.WAITING,
    createdAt: '2026-08-31 18:00'
  },
  {
    id: '5',
    title: '校园活动协助',
    category: '兼职',
    description: '协助布置校园活动现场，预计两小时。',
    reward: 30,
    location: '体育馆',
    deadline: '2026-09-20',
    status: TASK_STATUS.WAITING,
    createdAt: '2026-08-31 16:00'
  }
]

function getStoredTasks() {
  const tasks = wx.getStorageSync(STORAGE_KEY)
  return Array.isArray(tasks) ? tasks : []
}

function normalizeStatus(status) {
  const oldStatusMap = {
    '待接单': TASK_STATUS.WAITING,
    '已接单': TASK_STATUS.ACCEPTED,
    '待发布者确认': TASK_STATUS.WAITING_CONFIRM,
    '已完成': TASK_STATUS.COMPLETED
  }

  return oldStatusMap[status] || status || TASK_STATUS.WAITING
}

function normalizeTask(task) {
  // 兼容上一阶段已经通过发布页创建、但还没有标记字段的任务。
  const isOldLocalPublishedTask = String(task.id).startsWith('task_')

  return {
    ...task,
    status: normalizeStatus(task.status),
    isLocalPublished: task.isLocalPublished === true || isOldLocalPublishedTask
  }
}

function addStatusText(task) {
  const normalizedTask = normalizeTask(task)
  return {
    ...normalizedTask,
    statusText: STATUS_TEXT[normalizedTask.status] || '未知状态'
  }
}

function getAllTasks() {
  const storedTasks = getStoredTasks().map(normalizeTask)
  const storedTaskIds = new Set(storedTasks.map((task) => String(task.id)))
  const unusedDefaultTasks = DEFAULT_TASKS.filter(
    (task) => !storedTaskIds.has(String(task.id))
  )

  return storedTasks.concat(unusedDefaultTasks).map(addStatusText)
}

function saveTask(task) {
  const tasks = getStoredTasks()
  const taskToSave = normalizeTask(task)
  delete taskToSave.statusText
  tasks.unshift(taskToSave)
  wx.setStorageSync(STORAGE_KEY, tasks)
}

function getTaskById(taskId) {
  return getAllTasks().find((task) => String(task.id) === String(taskId))
}

function getLocalPublishedTasks() {
  return getAllTasks().filter((task) => task.isLocalPublished === true)
}

function updateTaskStatus(taskId, expectedStatus, newStatus) {
  const currentTask = getTaskById(taskId)

  if (!currentTask) {
    return { success: false, reason: 'NOT_FOUND' }
  }

  if (currentTask.status !== expectedStatus) {
    return {
      success: false,
      reason: 'STATUS_CHANGED',
      task: currentTask
    }
  }

  const tasks = getStoredTasks().map(normalizeTask)
  const taskIndex = tasks.findIndex(
    (task) => String(task.id) === String(taskId)
  )
  const updatedTask = {
    ...currentTask,
    status: newStatus
  }
  delete updatedTask.statusText

  if (taskIndex === -1) {
    // 默认演示任务第一次改变状态时，也写入本地存储。
    tasks.unshift(updatedTask)
  } else {
    tasks[taskIndex] = updatedTask
  }

  wx.setStorageSync(STORAGE_KEY, tasks)

  return {
    success: true,
    task: addStatusText(updatedTask)
  }
}

module.exports = {
  STORAGE_KEY,
  TASK_STATUS,
  getAllTasks,
  getLocalPublishedTasks,
  getTaskById,
  saveTask,
  updateTaskStatus
}
