const BFX = require('bitfinex-api-node')
const dayjs = require('dayjs')
const createLogger = require('./logging')

const logger = createLogger('bfx')

const apiKey = process.env.BITFINEX_API_KEY
const apiSecret = process.env.BITFINEX_API_KEY_SECRET
const bfx = new BFX({ apiKey, apiSecret })

async function getWallets() {
  const rest = bfx.rest()
  return await rest.wallets()
}

exports.getWallets = getWallets

async function ledgers(params) {
  const rest = bfx.rest()
  return await rest.ledgers(params)
}

exports.ledgers = ledgers

async function subscribeTrades({ symbol, statusKey }, onTrade, onStatus) {
  const ws = bfx.ws(2, { autoReconnect: true })

  let trades = {}
  ws.onAccountTradeEntry({ symbol }, (trade) => {
    logger.debug('trade entry', trade)
    const tradeId = trade[0]
    trades[tradeId] = trade
  })
  ws.onAccountTradeUpdate({ symbol }, (trade) => {
    logger.debug('trade update', trade)
    const tradeId = trade[0]
    const teData = trades[tradeId]
    if (!!teData) {
      delete trades[tradeId]
      if (onTrade)
        onTrade({
          id: tradeId,
          symbol: trade[1],
          mts: trade[2],
          orderId: trade[3],
          execAmount: trade[4],
          execPrice: trade[5],
          orderType: trade[6],
          orderPrice: trade[7],
          maker: trade[8] === 1,
          fee: trade[9],
          feeCurrency: trade[10],
          clientOrderId: trade[11],
        })
    }
  })

  let tsState = {}
  let lastTs = {}
  ws.onStatus({ key: statusKey }, (status) => {
    const currentTs = (tsState[statusKey] = tsState[statusKey] || status[7])
    const ts = status[0]
    if (ts >= currentTs && (!lastTs[statusKey] || lastTs[statusKey] !== ts)) {
      logger.debug('status %O', { currentTs, ts, status })
      const nextTs = status[7]
      const funding = status[11]
      lastTs[statusKey] = ts
      tsState[statusKey] = nextTs
      if (onStatus) {
        onStatus({ ts, nextTs, funding })
      }
    }
  })

  ws.on('error', (e) => logger.debug('subscribeTrades', e))
  ws.on('auth', () => logger.debug('auth :: authenticated'))
  ws.on('open', async () => {
    logger.debug('open :: subscribing to channels')

    trades = {}
    tsState = {}
    lastTs = {}
    try {
      logger.debug('open :: subscribing trades on %s', symbol)
      await ws.subscribeTrades(symbol)
      logger.debug('open :: subscribed trades on %s', symbol)
      logger.debug('open :: subscribing status on %s', statusKey)
      await ws.subscribeStatus(statusKey)
      logger.debug('open :: subscribed status on %s', statusKey)
    } catch (err) {
      logger.error('open :: error', err)
    }
  })

  logger.debug('subscribeTrades :: opening websocket')
  await ws.open()
  logger.debug('subscribeTrades :: opened websocket, authenticating')
  await ws.auth()
  logger.debug('subscribeTrades :: websocket authenticated')
  return { close: () => ws.close() }
}

exports.subscribeTrades = subscribeTrades
