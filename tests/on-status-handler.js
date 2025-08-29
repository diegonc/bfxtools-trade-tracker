import { createReadStream } from 'fs'
import { createInterface } from 'readline/promises'
import { Decompressor } from 'lzma-native'

import { onStatusHandlerCreator } from '../bitfinex-utils.js'
import { Gsheet, MemoryBackend } from '../gsheets/index.js'
import createLogger from '../logging.js'
;(async function main() {
  /* Initialize a memory backed trade tracker */
  const tracker = new Gsheet(
    new MemoryBackend('margin', 'USTF0', {
      getBalance() {
        return 100
      },
    })
  )
  await tracker.setupWorkingSheet()

  /* Add a trade to increase the position size above/below 0 */
  await tracker.addTrade({
    id: new Date().getTime(),
    mts: new Date().getTime(),
    execAmount: 0.00004,
    execPrice: 97100,
    fee: 0.0002,
  })

  const logger = createLogger('test-status-handler')
  const { state, resetState, onStatusHandler } = onStatusHandlerCreator(
    'deriv:tBTCF0:USTF0',
    (status) => {
      logger.debug('status %j', status)
      if (tracker._api._positionSize !== 0) {
        if (!!status.funding) {
          tracker
            .addFunding(status)
            .catch((err) => logger.error('main :: addFunding', err))
        }
      }
    }
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

  logger.info('tracker:\n%s', JSON.stringify(tracker._api._book, null, 2))
})()
