import { createReadStream } from 'fs'
import { createInterface } from 'readline/promises'
import { onStatusHandlerCreator } from '../bitfinex-utils'
import createLogger from '../logging'
;(async function main() {
  const logger = createLogger('test-status-handler')
  const { state, resetState, onStatusHandler } = onStatusHandlerCreator(
    'deriv:tBTCF0:USTF0',
    (funding) => logger.debug('funding %j', funding)
  )

  const stream = createReadStream('./status-log.txt')
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    onStatusHandler(JSON.parse(line))
  }
})()
