require('./config')

const BFX = require('bitfinex-api-node')
const createLogger = require('./logging')
const winston = require('winston')

const logger = createLogger('status-test')
logger.add(new winston.transports.File({ filename: 'status-test.log' }))

const apiKey = process.env.BITFINEX_API_KEY
const apiSecret = process.env.BITFINEX_API_KEY_SECRET

async function main() {
  const bfx = new BFX({ apiKey, apiSecret })
  const ws = bfx.ws(2, { autoReconnect: true })

  let nextTs = null
  ws.onStatus({ key: 'deriv:tBTCF0:USTF0' }, (status) => {
    nextTs = nextTs || status[7]
    const ts = status[0]
    if (Math.abs(nextTs - ts) < 30 * 1000) {
      logger.debug(
        'current funding %d (%j)',
        status[11],
        Object.entries(status)
      )
    } else if (ts - nextTs > 300000) {
      nextTs = nextTs || status[7]
    }
  })

  ws.on('open', () => {
    nextTs = null
    ws.subscribeStatus('deriv:tBTCF0:USTF0')
  })

  await ws.open()
  await ws.auth()
}

main()
