require('./config')

const BFX = require('bitfinex-api-node')
const { onStatusHandlerCreator } = require('./bitfinex-utils')
const winston = require('winston')
const createLogger = require('./logging')

const logger = createLogger('status-test')
logger.add(new winston.transports.File({ filename: 'status-test.log' }))

const apiKey = process.env.BITFINEX_API_KEY
const apiSecret = process.env.BITFINEX_API_KEY_SECRET

async function main() {
  const bfx = new BFX({ apiKey, apiSecret })
  const ws = bfx.ws(2, { autoReconnect: true })

  const statusKey = 'deriv:tBTCF0:USTF0'
  const { resetState, onStatusHandler } = onStatusHandlerCreator(
    statusKey,
    (status) => logger.debug('onStatus %j', status)
  )
  ws.onStatus({ key: statusKey }, onStatusHandler)

  ws.on('open', () => {
    resetState()
    ws.subscribeStatus('deriv:tBTCF0:USTF0')
  })

  await ws.open()
  await ws.auth()
}

main()
