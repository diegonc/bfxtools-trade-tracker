import { RetryableQueue } from '../queue/index.js'

const queue = new RetryableQueue({ concurrency: 1 })

function task(id) {
  return async function taskfn(attempt) {
    return new Promise((resolve) =>
      setTimeout(resolve, 100 + Math.random() * 100)
    ).then(() => console.log(`[${id}] attempt ${attempt} done`))
  }
}

function fail(id, atAttempt) {
  return async function taskfn(attempt) {
    if (attempt === atAttempt) {
      console.log(`[${id}] success at attempt ${attempt}`)
      return
    }

    return new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`[${id}] fail at attempt ${attempt}`)),
        Math.random() * 200
      )
    )
  }
}

/* TODO awaiting each queue task serializes all retry attempts */
/* TODO awaiting them all in any order works as expected... */
await Promise.all([
  queue.addRetryableTask(task(1)),
  queue.addRetryableTask(task(2)),
  queue.addRetryableTask(fail(3, 4)),
  queue.addRetryableTask(task(4)),
  queue.addRetryableTask(task(5)),
  queue.addRetryableTask(fail(6, 2)),
  queue.addRetryableTask(task(7)),
  // ...still rejections must be caught to avoid the program stopping
  queue.addRetryableTask(fail(8, 6)).catch((err) => console.error("err", err.message)),
])
console.log('All tests ran')
