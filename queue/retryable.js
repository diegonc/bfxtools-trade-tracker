import PQueue from 'p-queue'

export class RetryableQueue extends PQueue {
  /**
   * Add a retryable task to the queue.
   * @param {function(number): Promise<any>} taskFn - async task function, receives attempt number
   * @param {object} options - retry/backoff options
   * @param {number} options.retries - max attempts (default 5)
   * @param {number} options.minTimeout - minimum delay in ms (default 500)
   * @param {number} options.maxTimeout - maximum delay in ms (default 5000)
   * @param {number} options.factor - exponential factor (default 2)
   * @param {boolean} options.randomize - add jitter (default true)
   */
  addRetryableTask(
    taskFn,
    {
      retries = 5,
      minTimeout = 500,
      maxTimeout = 5000,
      factor = 2,
      randomize = true,
    } = {}
  ) {
    let attempt = 1

    return new Promise((resolve, reject) => {
      const runAttempt = async () => {
        try {
          const result = await taskFn(attempt)
          resolve(result) // success
        } catch (err) {
          if (attempt < retries) {
            console.log(`Task failed on attempt ${attempt}: ${err.message}`)
            attempt++
            await this.#waitWithBackoff(attempt, {
              minTimeout,
              maxTimeout,
              factor,
              randomize,
            })
            this.add(runAttempt) // re-enqueue next attempt
          } else {
            reject(
              new Error(
                `Task ultimately failed after ${attempt} attempts: ${err.message}`
              )
            )
          }
        }
      }

      this.add(runAttempt) // enqueue first attempt
    })
  }

  // Private helper: calculate delay for a given attempt with exponential backoff + jitter
  async #waitWithBackoff(
    attempt,
    { minTimeout = 500, maxTimeout = 5000, factor = 2, randomize = true } = {}
  ) {
    let delay = minTimeout * Math.pow(factor, attempt - 1)
    delay = Math.min(delay, maxTimeout)

    if (randomize) {
      const rand = Math.random() + 0.5 // jitter between 0.5x and 1.5x
      delay = Math.floor(delay * rand)
    }

    return new Promise((resolve) => setTimeout(resolve, delay))
  }
}
