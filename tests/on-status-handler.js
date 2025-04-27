import { open } from 'fs/promises'
import { onStatusHandlerCreator } from '../bitfinex-utils'
import createLogger from '../logging'
;(async function main() {
  const logger = createLogger('test-status-handler')
  const { state, resetState, onStatusHandler } = onStatusHandlerCreator(
    'deriv:tBTCF0:USTF0',
    (funding) => logger.debug('funding %j', funding)
  )

  const file = await open('./status-log.txt')
  for await (const line of file.readLines()) {
    onStatusHandler(JSON.parse(line))
  }
})()
