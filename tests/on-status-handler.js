import { createReadStream } from 'fs'
import { createInterface } from 'readline/promises'
import { Decompressor } from 'lzma-native'

import { onStatusHandlerCreator } from '../bitfinex-utils.js'
import createLogger from '../logging.js'
;(async function main() {
  const logger = createLogger('test-status-handler')
  const { state, resetState, onStatusHandler } = onStatusHandlerCreator(
    'deriv:tBTCF0:USTF0',
    (funding) => logger.debug('funding %j', funding)
  )

  const readStream = createReadStream(
    new URL('./status-log.txt.xz', import.meta.url)
  )
  const decompStream = Decompressor()
  const rl = createInterface({
    input: decompStream,
    crlfDelay: Infinity,
  })

  readStream.pipe(decompStream)

  for await (const line of rl) {
    onStatusHandler(JSON.parse(line))
  }
})()
